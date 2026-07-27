/**
 * Fingerprint a URL and capture matching n-day / CVE references into the
 * local PoC catalog.
 *
 *   bun run scripts/redscope-fingerprint-nday.ts --url https://target.example
 *   bun run scripts/redscope-fingerprint-nday.ts --url https://target.example --offline
 *   bun run scripts/redscope-fingerprint-nday.ts --header "server: Apache/2.4.49" --body "..."
 */

import {
  fingerprintHttpResponse,
  type HttpFingerprintInput,
} from '../src/utils/techFingerprint.ts'
import { captureNdaysForFingerprint } from '../src/utils/ndayCapture.ts'
import { reportHostProgress } from '../src/utils/engagementProgress.ts'

function parseArgs(argv: string[]) {
  let url: string | undefined
  let offline = false
  let body = ''
  const headers: Record<string, string> = {}
  let hostId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') url = argv[++i]
    else if (a === '--offline') offline = true
    else if (a === '--body') body = argv[++i] ?? ''
    else if (a === '--header') {
      const raw = argv[++i] ?? ''
      const idx = raw.indexOf(':')
      if (idx > 0) {
        headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
      }
    } else if (a === '--host-id') hostId = argv[++i]
    else if (a === '--help' || a === '-h') {
      return { help: true as const }
    }
  }
  return { url, offline, body, headers, hostId, help: false as const }
}

async function fetchTarget(
  url: string,
): Promise<HttpFingerprintInput> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'RedScopeAI-Fingerprint/1.0' },
    })
    const hdrs: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      hdrs[k] = v
    })
    const body = await res.text()
    return {
      url,
      finalUrl: res.url,
      statusCode: res.status,
      headers: hdrs,
      body: body.slice(0, 200_000),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  bun run scripts/redscope-fingerprint-nday.ts --url https://target.example
  bun run scripts/redscope-fingerprint-nday.ts --header "server: nginx/1.18" --body "<title>GitLab</title>"
  bun run scripts/redscope-fingerprint-nday.ts --url https://target.example --offline
  bun run scripts/redscope-fingerprint-nday.ts --url https://target.example --host-id ext-web`)
    return
  }

  let input: HttpFingerprintInput
  if (args.url && Object.keys(args.headers).length === 0 && !args.body) {
    console.log(`[fingerprint] fetching ${args.url} …`)
    input = await fetchTarget(args.url)
  } else {
    input = {
      url: args.url,
      headers: args.headers,
      body: args.body,
    }
  }

  const fp = fingerprintHttpResponse(input)
  console.log(
    `[fingerprint] products: ${fp.products.length ? fp.products.join(', ') : '(none)'}`,
  )
  for (const s of fp.signals.slice(0, 12)) {
    console.log(
      `  · ${s.product} via ${s.kind}/${s.key} (conf ${s.confidence})`,
    )
  }

  if (fp.products.length === 0) {
    console.log('[fingerprint] no products — nothing to capture')
    return
  }

  if (args.hostId) {
    reportHostProgress({
      hostId: args.hostId,
      progress: 25,
      activity: `fingerprint: ${fp.products.slice(0, 3).join(', ')}`,
      status: 'scanning',
      label: args.hostId,
      ip: args.url,
    })
  }

  console.log('[nday] matching local catalog + optional NVD …')
  const captured = await captureNdaysForFingerprint(fp, {
    online: !args.offline,
  })
  console.log(
    `[nday] ${captured.hits.length} hit(s), newlyAdded=${captured.newlyAdded}, catalogTotal=${captured.catalogTotal}`,
  )
  // Show ids only (short) — full advisory text stays in the catalog file.
  for (const hit of captured.hits.slice(0, 15)) {
    console.log(
      `  · ${hit.entry.id} [${hit.source}] score=${hit.score.toFixed(2)} ← ${hit.matchedProduct}`,
    )
  }
  if (captured.hits.length > 15) {
    console.log(`  … ${captured.hits.length - 15} more (see ${captured.catalogPath})`)
  }

  if (args.hostId) {
    reportHostProgress({
      hostId: args.hostId,
      progress: 40,
      activity: `nday capture: ${captured.hits.length} hits (+${captured.newlyAdded} new)`,
      status: 'testing',
    })
  }
}

main().catch(error => {
  console.error(
    `[fingerprint-nday] fatal: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
