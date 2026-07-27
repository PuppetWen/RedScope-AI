/**
 * Public free-proxy pool scraper + rotator.
 *
 * Fetches free proxy endpoints from well-known public list pages / raw text
 * feeds, normalizes them into egress nodes, caps at ~500, and writes an
 * auto-updated pool the egress engine can rotate through.
 *
 * Sources are public pages (no auth). Lists are noisy and short-lived — the
 * health-check path in `redscope-egress-refresh` / `applyEgressHealthResult`
 * is expected to cool dead nodes quickly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  normalizeEgressConfig,
  type EgressConfig,
  type EgressNode,
  type EgressPool,
} from './egressPool.js'
import { getPreferredUserConfigFile } from './redscopeCompat.js'
import { getCwd } from './cwd.js'

export const PUBLIC_PROXY_POOL_ID = 'public-free-proxy-pool'
export const PUBLIC_PROXY_FILENAME = 'public-free-proxies.json'
export const DEFAULT_PUBLIC_PROXY_TARGET = 500

/** Well-known public free-proxy raw list endpoints (plain text host:port). */
export const DEFAULT_PUBLIC_PROXY_SOURCES: readonly string[] = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=5000&country=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://www.proxy-list.download/api/v1/get?type=socks4',
  'https://www.proxy-list.download/api/v1/get?type=socks5',
]

const HOST_PORT_RE =
  /\b((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,}):(\d{2,5})\b/gi

export type ParsedPublicProxy = {
  host: string
  port: number
  protocol: 'http' | 'socks4' | 'socks5'
  source: string
}

export type PublicProxyScrapeResult = {
  fetchedAt: string
  sourcesAttempted: number
  sourcesOk: number
  rawParsed: number
  unique: number
  kept: number
  nodes: EgressNode[]
  errors: string[]
}

function inferProtocol(sourceUrl: string, fallback: 'http' = 'http'): 'http' | 'socks4' | 'socks5' {
  const u = sourceUrl.toLowerCase()
  if (u.includes('socks5')) return 'socks5'
  if (u.includes('socks4')) return 'socks4'
  if (u.includes('socks')) return 'socks5'
  return fallback
}

/**
 * Parse a free-proxy list body (plain text or lightly HTML-wrapped) into
 * host/port pairs. Pure + testable.
 */
export function parsePublicProxyListBody(
  body: string,
  sourceUrl: string,
): ParsedPublicProxy[] {
  const protocol = inferProtocol(sourceUrl)
  const out: ParsedPublicProxy[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(HOST_PORT_RE)) {
    const host = match[1]!
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    // Skip obvious non-proxy ports that show up in HTML chrome.
    if ([80, 443].includes(port) && sourceUrl.includes('<')) continue
    const key = `${protocol}://${host}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ host, port, protocol, source: sourceUrl })
  }
  return out
}

export function publicProxyToNode(
  proxy: ParsedPublicProxy,
  index: number,
): EgressNode {
  const id = `pub-${proxy.protocol}-${proxy.host.replace(/\W/g, '-')}-${proxy.port}`
  return {
    id: id.length > 80 ? `pub-${index}-${proxy.port}` : id,
    name: `Public ${proxy.protocol.toUpperCase()} ${proxy.host}:${proxy.port}`,
    endpoint: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    sourceIp: proxy.host,
    provider: 'public-free-list',
    region: 'public',
    approvedBy: 'user-first-run-opt-in',
    approvalReference: 'FIRST-RUN-PUBLIC-PROXY-OPT-IN',
    enabled: true,
  }
}

export function dedupeAndCapProxies(
  proxies: ParsedPublicProxy[],
  limit = DEFAULT_PUBLIC_PROXY_TARGET,
): ParsedPublicProxy[] {
  const seen = new Set<string>()
  const out: ParsedPublicProxy[] = []
  for (const p of proxies) {
    const key = `${p.protocol}|${p.host}|${p.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

export function buildPublicProxyEgressConfig(
  nodes: EgressNode[],
  opts?: { refreshIntervalHours?: number; statePath?: string },
): EgressConfig {
  const pool: EgressPool = {
    id: PUBLIC_PROXY_POOL_ID,
    name: 'Public Free Proxy Pool (user opt-in)',
    owner: 'user',
    authorization: {
      authorizedBy: 'user-first-run-opt-in',
      reference: 'FIRST-RUN-PUBLIC-PROXY-OPT-IN',
      validFrom: new Date().toISOString().slice(0, 10),
    },
    rateLimits: { requestsPerSecond: 2, concurrency: 2 },
    nodes,
  }
  return normalizeEgressConfig({
    schemaVersion: 1,
    policy: {
      // User explicitly opted into public free proxies via first-run / scrape.
      requireAuthorization: true,
      disallowPublicFreeProxies: false,
      disallowUnverifiedNodes: false,
      autoUseForAuthorizedTesting: true,
      defaultPoolId: PUBLIC_PROXY_POOL_ID,
      maxAutoSwitchesPerStep: 20,
      switchOnHttpStatuses: [403, 407, 429, 451, 502, 503],
      validateBeforeUse: true,
      connectivityCheckTimeoutMs: 2500,
      avoidPreviouslyUsedNodesPerTarget: true,
      defaultRefreshIntervalDays: (opts?.refreshIntervalHours ?? 6) / 24,
      blockedCooldownHours: 2,
      statePath:
        opts?.statePath ??
        getPreferredUserConfigFile('public-free-proxy-state.json'),
      notes: [
        'Pool built from public free-proxy list pages at user request (first-run opt-in or redscope:proxy-scrape).',
        'Nodes are short-lived; run health checks frequently and expect high attrition.',
        'Only use against targets you are authorized to test.',
      ],
    },
    egressPools: [pool],
  })
}

export function getPublicProxyPoolPath(): string {
  return getPreferredUserConfigFile(PUBLIC_PROXY_FILENAME)
}

export function getWorkspacePublicProxyPoolPath(): string {
  return join(getCwd(), PUBLIC_PROXY_FILENAME)
}

export function savePublicProxyPool(
  config: EgressConfig,
  path = getPublicProxyPoolPath(),
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  // Also drop a workspace copy so engagement folders can see the pool.
  try {
    const ws = getWorkspacePublicProxyPoolPath()
    if (ws !== path) {
      writeFileSync(ws, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    }
  } catch {
    // workspace may be read-only; user-config write is the source of truth
  }
}

export function loadPublicProxyPool(
  path = getPublicProxyPoolPath(),
): EgressConfig | null {
  const candidates = [path, getWorkspacePublicProxyPoolPath()]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return normalizeEgressConfig(JSON.parse(readFileSync(p, 'utf-8')))
    } catch {
      // try next
    }
  }
  return null
}

export type FetchText = (
  url: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; body?: string; error?: string }>

async function defaultFetchText(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'RedScopeAI-ProxyScraper/1.0 (+authorized-lab-use)',
        Accept: 'text/plain,*/*',
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.text()
    return { ok: true, body }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scrape public free-proxy list pages and return up to `limit` unique nodes.
 */
export async function scrapePublicProxies(options?: {
  sources?: readonly string[]
  limit?: number
  timeoutMs?: number
  fetchText?: FetchText
}): Promise<PublicProxyScrapeResult> {
  const sources = options?.sources ?? DEFAULT_PUBLIC_PROXY_SOURCES
  const limit = options?.limit ?? DEFAULT_PUBLIC_PROXY_TARGET
  const timeoutMs = options?.timeoutMs ?? 8000
  const fetchText = options?.fetchText ?? defaultFetchText

  const all: ParsedPublicProxy[] = []
  const errors: string[] = []
  let sourcesOk = 0

  for (const source of sources) {
    const res = await fetchText(source, timeoutMs)
    if (!res.ok || !res.body) {
      errors.push(`${source}: ${res.error ?? 'empty'}`)
      continue
    }
    sourcesOk += 1
    all.push(...parsePublicProxyListBody(res.body, source))
  }

  const kept = dedupeAndCapProxies(all, limit)
  const nodes = kept.map((p, i) => publicProxyToNode(p, i))

  return {
    fetchedAt: new Date().toISOString(),
    sourcesAttempted: sources.length,
    sourcesOk,
    rawParsed: all.length,
    unique: new Set(all.map(p => `${p.protocol}|${p.host}|${p.port}`)).size,
    kept: nodes.length,
    nodes,
    errors,
  }
}

/**
 * Scrape + persist a public free-proxy egress pool. Returns the config written.
 */
export async function refreshPublicProxyPool(options?: {
  sources?: readonly string[]
  limit?: number
  timeoutMs?: number
  fetchText?: FetchText
  path?: string
}): Promise<{ result: PublicProxyScrapeResult; config: EgressConfig }> {
  const result = await scrapePublicProxies(options)
  const config = buildPublicProxyEgressConfig(result.nodes)
  savePublicProxyPool(config, options?.path ?? getPublicProxyPoolPath())
  return { result, config }
}
