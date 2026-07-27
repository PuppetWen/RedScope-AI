/**
 * PoC reference catalog.
 *
 * This is a *reference index*, not an exploit arsenal. Each entry is public
 * vulnerability metadata (CVE id, affected product, severity, links to the
 * vendor/official advisory) that a red-team operator can use to plan work
 * inside an authorized engagement. Deliberate non-goals, so this stays a
 * legitimate knowledge base rather than an autonomous attack tool:
 *   - no weaponized exploit code is stored or generated here;
 *   - nothing in this module runs a PoC against a live target;
 *   - every entry is scope-gated (`requiresAuthorizedScope`) by default.
 *
 * The catalog lives in the current working directory
 * (`redscope-poc-catalog.json`) so it travels with an engagement's workspace.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from './cwd.js'

export const POC_CATALOG_FILENAME = 'redscope-poc-catalog.json'

export type PocSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

const SEVERITIES: readonly PocSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'unknown',
]

export type PocReference = {
  id: string
  title: string
  product?: string
  category?: string
  severity: PocSeverity
  cvss?: number
  references: string[]
  requiresAuthorizedScope: boolean
  addedAt?: string
  notes?: string
}

export type PocCatalog = {
  schemaVersion: number
  generatedAt?: string
  entries: PocReference[]
}

function normalizeSeverity(value: unknown): PocSeverity {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if ((SEVERITIES as readonly string[]).includes(lower)) {
      return lower as PocSeverity
    }
  }
  return 'unknown'
}

function normalizeEntry(raw: unknown): PocReference | null {
  const e = (raw ?? {}) as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.title !== 'string') return null
  const references = Array.isArray(e.references)
    ? e.references.filter((r): r is string => typeof r === 'string')
    : []
  const cvss =
    typeof e.cvss === 'number' && Number.isFinite(e.cvss)
      ? Math.min(10, Math.max(0, e.cvss))
      : undefined
  return {
    id: e.id,
    title: e.title,
    product: typeof e.product === 'string' ? e.product : undefined,
    category: typeof e.category === 'string' ? e.category : undefined,
    severity: normalizeSeverity(e.severity),
    cvss,
    references,
    // Opt-out is intentionally impossible to do by omission: a missing flag
    // means scope IS required.
    requiresAuthorizedScope: e.requiresAuthorizedScope !== false,
    addedAt: typeof e.addedAt === 'string' ? e.addedAt : undefined,
    notes: typeof e.notes === 'string' ? e.notes : undefined,
  }
}

/**
 * Validate + normalize a raw catalog object. Malformed entries are dropped, and
 * duplicate ids are de-duplicated (first wins) so the count is trustworthy.
 */
export function normalizePocCatalog(raw: unknown): PocCatalog {
  const r = (raw ?? {}) as Record<string, unknown>
  const seen = new Set<string>()
  const entries: PocReference[] = []
  if (Array.isArray(r.entries)) {
    for (const item of r.entries) {
      const entry = normalizeEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
    }
  }
  return {
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : 1,
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : undefined,
    entries,
  }
}

export type PocCatalogSummary = {
  present: boolean
  total: number
  scopeGated: number
  bySeverity: Record<PocSeverity, number>
  categories: string[]
}

export function summarizePocCatalog(
  catalog: PocCatalog | null,
): PocCatalogSummary {
  const bySeverity: Record<PocSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  }
  if (!catalog) {
    return {
      present: false,
      total: 0,
      scopeGated: 0,
      bySeverity,
      categories: [],
    }
  }
  const categories = new Set<string>()
  let scopeGated = 0
  for (const entry of catalog.entries) {
    bySeverity[entry.severity] += 1
    if (entry.requiresAuthorizedScope) scopeGated += 1
    if (entry.category) categories.add(entry.category)
  }
  return {
    present: true,
    total: catalog.entries.length,
    scopeGated,
    bySeverity,
    categories: Array.from(categories).sort(),
  }
}

export function formatPocCatalogStatus(summary: PocCatalogSummary): string {
  if (!summary.present || summary.total === 0) {
    return [
      'PoC references: 0',
      `  add ${POC_CATALOG_FILENAME} in the workspace to index authorized PoC references`,
    ].join('\n')
  }
  const sev = summary.bySeverity
  return [
    `PoC references: ${summary.total} (${summary.scopeGated} scope-gated)`,
    `  critical=${sev.critical} high=${sev.high} medium=${sev.medium} low=${sev.low}`,
    summary.categories.length > 0
      ? `  categories: ${summary.categories.join(', ')}`
      : '  categories: none',
  ].join('\n')
}

export function getPocCatalogPath(): string {
  return join(getCwd(), POC_CATALOG_FILENAME)
}

export function loadPocCatalog(): PocCatalog | null {
  const path = getPocCatalogPath()
  if (!existsSync(path)) return null
  try {
    return normalizePocCatalog(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}
