/**
 * Fingerprint → n-day capture.
 *
 * When a target's tech fingerprint is known, look up matching public n-day /
 * CVE references (local catalog first, then optional online NVD search) and
 * append any new hits to the workspace PoC catalog for reuse next time.
 *
 * This stores *references* (id, title, product, advisory links). It does not
 * download exploit code. Live verification is handled separately by
 * `pocVerification.ts` and requires evidence beyond version banners.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import {
  loadPocCatalog,
  normalizePocCatalog,
  type PocCatalog,
  type PocReference,
  type PocSeverity,
  getPocCatalogPath,
  POC_CATALOG_FILENAME,
} from './pocCatalog.js'
import {
  productMatchScore,
  type TechFingerprint,
} from './techFingerprint.js'

export type NdayHit = {
  entry: PocReference
  matchedProduct: string
  score: number
  source: 'local-catalog' | 'nvd' | 'manual'
}

export type NdayCaptureResult = {
  fingerprintProducts: string[]
  hits: NdayHit[]
  newlyAdded: number
  catalogTotal: number
  catalogPath: string
}

function severityFromCvss(cvss?: number): PocSeverity {
  if (cvss === undefined) return 'unknown'
  if (cvss >= 9) return 'critical'
  if (cvss >= 7) return 'high'
  if (cvss >= 4) return 'medium'
  return 'low'
}

/** Match fingerprint products against an in-memory / on-disk catalog. */
export function matchFingerprintToCatalog(
  fingerprint: TechFingerprint,
  catalog: PocCatalog | null,
  minScore = 0.55,
): NdayHit[] {
  if (!catalog || catalog.entries.length === 0) return []
  if (fingerprint.products.length === 0) return []

  const hits: NdayHit[] = []
  for (const entry of catalog.entries) {
    if (!entry.product) continue
    let best = 0
    let matched = ''
    for (const product of fingerprint.products) {
      const score = productMatchScore(entry.product, product)
      if (score > best) {
        best = score
        matched = product
      }
    }
    if (best >= minScore) {
      hits.push({
        entry,
        matchedProduct: matched,
        score: best,
        source: 'local-catalog',
      })
    }
  }
  // Higher score first, then severity-ish by cvss
  hits.sort((a, b) => b.score - a.score || (b.entry.cvss ?? 0) - (a.entry.cvss ?? 0))
  return hits
}

/**
 * Query NVD's public API for CVEs related to a product keyword.
 * Network optional — failures return [].
 */
export async function searchNvdForProduct(
  product: string,
  options?: { limit?: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<PocReference[]> {
  const limit = options?.limit ?? 8
  const timeoutMs = options?.timeoutMs ?? 8000
  const fetchImpl = options?.fetchImpl ?? fetch
  const url =
    `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(
      product,
    )}&resultsPerPage=${limit}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedScopeAI-NdayCapture/1.0',
      },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      vulnerabilities?: Array<{
        cve?: {
          id?: string
          descriptions?: Array<{ lang?: string; value?: string }>
          metrics?: {
            cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>
            cvssMetricV30?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>
            cvssMetricV2?: Array<{ cvssData?: { baseScore?: number } }>
          }
          references?: Array<{ url?: string }>
        }
      }>
    }
    const out: PocReference[] = []
    for (const item of data.vulnerabilities ?? []) {
      const cve = item.cve
      if (!cve?.id) continue
      const desc =
        cve.descriptions?.find(d => d.lang === 'en')?.value ??
        cve.descriptions?.[0]?.value ??
        cve.id
      const cvss =
        cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore ??
        cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore ??
        cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseScore
      const sevRaw =
        cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity ??
        cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity
      const severity = (
        sevRaw ? sevRaw.toLowerCase() : severityFromCvss(cvss)
      ) as PocSeverity
      const refs = (cve.references ?? [])
        .map(r => r.url)
        .filter((u): u is string => typeof u === 'string')
        .slice(0, 4)
      if (!refs.some(r => r.includes('nvd.nist.gov'))) {
        refs.unshift(`https://nvd.nist.gov/vuln/detail/${cve.id}`)
      }
      out.push({
        id: cve.id,
        title: desc.slice(0, 180),
        product,
        category: 'nday',
        severity: ['critical', 'high', 'medium', 'low', 'unknown'].includes(
          severity,
        )
          ? severity
          : severityFromCvss(cvss),
        cvss,
        references: refs,
        requiresAuthorizedScope: true,
        addedAt: new Date().toISOString().slice(0, 10),
        notes: `Captured from NVD keyword search for fingerprint product "${product}"`,
      })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Merge new entries into a catalog (first-id-wins). Returns count newly added. */
export function mergePocEntries(
  catalog: PocCatalog,
  entries: PocReference[],
): { catalog: PocCatalog; added: number } {
  const seen = new Set(catalog.entries.map(e => e.id.toUpperCase()))
  const merged = catalog.entries.slice()
  let added = 0
  for (const entry of entries) {
    const id = entry.id.toUpperCase()
    if (seen.has(id)) continue
    seen.add(id)
    merged.push({ ...entry, id: entry.id })
    added += 1
  }
  return {
    catalog: {
      ...catalog,
      schemaVersion: catalog.schemaVersion || 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      entries: merged,
    },
    added,
  }
}

export function savePocCatalog(catalog: PocCatalog, path = getPocCatalogPath()): void {
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8')
}

/**
 * Given a fingerprint, find local + (optional) online n-day refs and persist
 * any new ones into the workspace catalog.
 */
export async function captureNdaysForFingerprint(
  fingerprint: TechFingerprint,
  options?: {
    online?: boolean
    minScore?: number
    nvdLimitPerProduct?: number
    catalogPath?: string
    fetchImpl?: typeof fetch
  },
): Promise<NdayCaptureResult> {
  const catalogPath = options?.catalogPath ?? getPocCatalogPath()
  let catalog =
    (options?.catalogPath && existsSync(options.catalogPath)
      ? normalizePocCatalog(
          JSON.parse(readFileSync(options.catalogPath, 'utf-8')),
        )
      : null) ??
    loadPocCatalog() ??
    ({ schemaVersion: 1, entries: [] } satisfies PocCatalog)

  const localHits = matchFingerprintToCatalog(
    fingerprint,
    catalog,
    options?.minScore ?? 0.55,
  )

  const onlineEntries: PocReference[] = []
  if (options?.online !== false) {
    for (const product of fingerprint.products.slice(0, 5)) {
      const found = await searchNvdForProduct(product, {
        limit: options?.nvdLimitPerProduct ?? 5,
        fetchImpl: options?.fetchImpl,
      })
      onlineEntries.push(...found)
    }
  }

  const onlineHits: NdayHit[] = onlineEntries.map(entry => ({
    entry,
    matchedProduct: entry.product ?? fingerprint.products[0] ?? 'unknown',
    score: 0.75,
    source: 'nvd' as const,
  }))

  const toMerge = [
    ...localHits.map(h => h.entry),
    ...onlineEntries,
  ]
  // Re-merge online into catalog so next run is local-only fast path
  const { catalog: next, added } = mergePocEntries(catalog, toMerge)
  if (added > 0 || !existsSync(catalogPath)) {
    savePocCatalog(next, catalogPath)
    catalog = next
  }

  // De-dupe hits by id for the return payload
  const seen = new Set<string>()
  const hits: NdayHit[] = []
  for (const hit of [...localHits, ...onlineHits]) {
    const id = hit.entry.id.toUpperCase()
    if (seen.has(id)) continue
    seen.add(id)
    hits.push(hit)
  }

  return {
    fingerprintProducts: fingerprint.products.slice(),
    hits,
    newlyAdded: added,
    catalogTotal: catalog.entries.length,
    catalogPath,
  }
}

export { POC_CATALOG_FILENAME }
