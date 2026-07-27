/**
 * First-run setup for freshly installed RedScope workspaces / user configs.
 *
 * On first launch the operator is asked (once) whether to:
 *   1. Scrape ~500 public free-proxy endpoints for IP rotation
 *   2. Collect ≥100 PoC / n-day references into the local catalog
 *      (PoC collection is silent in the UI — no catalog dump to the user)
 *
 * Answers are persisted under ~/.redscope/first-run.json so the prompt never
 * reappears unless the user deletes that file or passes --reset-first-run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { getPreferredUserConfigFile } from './redscopeCompat.js'
import {
  DEFAULT_PUBLIC_PROXY_TARGET,
  refreshPublicProxyPool,
  loadPublicProxyPool,
} from './publicProxyPool.js'
import { loadPocCatalog, summarizePocCatalog } from './pocCatalog.js'
import { getPocCatalogPath } from './pocCatalog.js'

export const FIRST_RUN_STATE_FILE = 'first-run.json'

export type FirstRunState = {
  schemaVersion: number
  completedAt?: string
  askedAt?: string
  /** User accepted public proxy scrape */
  scrapeProxies: boolean
  /** User accepted silent PoC catalog collection */
  collectPocs: boolean
  proxyCount?: number
  pocCount?: number
  lastProxyRefreshAt?: string
  lastPocRefreshAt?: string
  notes?: string[]
}

export type FirstRunPrompt = {
  needed: boolean
  reason: 'first-run' | 'incomplete' | 'ok'
  state: FirstRunState | null
  message: string
  /** Short options the TUI / CLI can render. */
  options: Array<{ id: 'yes' | 'no' | 'proxies-only' | 'pocs-only'; label: string }>
}

export function getFirstRunStatePath(): string {
  return getPreferredUserConfigFile(FIRST_RUN_STATE_FILE)
}

export function loadFirstRunState(
  path = getFirstRunStatePath(),
): FirstRunState | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FirstRunState>
    return {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      completedAt: raw.completedAt,
      askedAt: raw.askedAt,
      scrapeProxies: Boolean(raw.scrapeProxies),
      collectPocs: Boolean(raw.collectPocs),
      proxyCount: raw.proxyCount,
      pocCount: raw.pocCount,
      lastProxyRefreshAt: raw.lastProxyRefreshAt,
      lastPocRefreshAt: raw.lastPocRefreshAt,
      notes: raw.notes,
    }
  } catch {
    return null
  }
}

export function saveFirstRunState(
  state: FirstRunState,
  path = getFirstRunStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

export function defaultFirstRunState(): FirstRunState {
  return {
    schemaVersion: 1,
    scrapeProxies: false,
    collectPocs: false,
  }
}

/**
 * Decide whether the first-run prompt should be shown.
 * Pure-ish: only reads state + whether pools/catalogs already exist.
 */
export function getFirstRunPrompt(nowIso = new Date().toISOString()): FirstRunPrompt {
  const state = loadFirstRunState()
  const options: FirstRunPrompt['options'] = [
    {
      id: 'yes',
      label: `Yes — scrape ~${DEFAULT_PUBLIC_PROXY_TARGET} public IPs + collect PoC refs (≥100, silent)`,
    },
    { id: 'proxies-only', label: `Proxies only — scrape ~${DEFAULT_PUBLIC_PROXY_TARGET} public IPs` },
    { id: 'pocs-only', label: 'PoC refs only — collect ≥100 references silently' },
    { id: 'no', label: 'No — skip (you can run redscope:proxy-scrape / redscope:poc-catalog later)' },
  ]

  if (!state || !state.completedAt) {
    return {
      needed: true,
      reason: 'first-run',
      state,
      message: [
        'Welcome to RedScope AI.',
        'First-run setup can prepare an IP rotation pool and a local n-day/PoC reference catalog.',
        `• Public free-proxy scrape: target ${DEFAULT_PUBLIC_PROXY_TARGET} endpoints (for authorized testing egress).`,
        '• PoC / n-day collection: ≥100 public CVE advisory references (stored locally, not printed).',
        'Only use these against targets you are authorized to test.',
      ].join('\n'),
      options,
    }
  }

  // Completed, but user said yes and assets are missing → offer repair once via incomplete.
  const proxyPool = loadPublicProxyPool()
  const poc = loadPocCatalog()
  const proxyOk =
    !state.scrapeProxies ||
    (proxyPool !== null &&
      (proxyPool.egressPools[0]?.nodes.length ?? 0) >= 50)
  const pocOk =
    !state.collectPocs ||
    (poc !== null && poc.entries.length >= 100)

  if (!proxyOk || !pocOk) {
    return {
      needed: true,
      reason: 'incomplete',
      state,
      message: [
        'First-run was accepted earlier but assets look incomplete.',
        !proxyOk
          ? `• Public proxy pool missing or <50 nodes (want ~${DEFAULT_PUBLIC_PROXY_TARGET}).`
          : null,
        !pocOk ? '• PoC catalog missing or <100 entries.' : null,
        'Re-run collection?',
      ]
        .filter(Boolean)
        .join('\n'),
      options,
    }
  }

  return {
    needed: false,
    reason: 'ok',
    state,
    message: `First-run complete (${state.completedAt ?? nowIso}).`,
    options: [],
  }
}

export type FirstRunChoice = 'yes' | 'no' | 'proxies-only' | 'pocs-only'

export type FirstRunExecutionResult = {
  state: FirstRunState
  proxy?: {
    kept: number
    sourcesOk: number
    sourcesAttempted: number
    errors: string[]
  }
  poc?: {
    total: number
    path: string
  }
  logs: string[]
}

/**
 * Apply the user's first-run choice. Proxy scrape hits the network; PoC
 * collection prefers the local generator script output / existing catalog
 * expansion without dumping entries to the console.
 */
export async function executeFirstRunChoice(
  choice: FirstRunChoice,
  options?: {
    proxyLimit?: number
    /** Injected for tests — skip network. */
    refreshProxies?: typeof refreshPublicProxyPool
    /** Injected for tests — build/ensure poc catalog. */
    ensurePocCatalog?: () => Promise<{ total: number; path: string }>
  },
): Promise<FirstRunExecutionResult> {
  const logs: string[] = []
  const scrapeProxies = choice === 'yes' || choice === 'proxies-only'
  const collectPocs = choice === 'yes' || choice === 'pocs-only'
  const nowIso = new Date().toISOString()

  const state: FirstRunState = {
    schemaVersion: 1,
    askedAt: nowIso,
    completedAt: nowIso,
    scrapeProxies,
    collectPocs,
    notes: [
      choice === 'no'
        ? 'User declined first-run collection.'
        : 'User opted into first-run collection.',
    ],
  }

  const result: FirstRunExecutionResult = { state, logs }

  if (choice === 'no') {
    logs.push('Skipped proxy scrape and PoC collection.')
    saveFirstRunState(state)
    return result
  }

  if (scrapeProxies) {
    logs.push(
      `Scraping public free-proxy lists (target ${options?.proxyLimit ?? DEFAULT_PUBLIC_PROXY_TARGET})…`,
    )
    try {
      const refresh = options?.refreshProxies ?? refreshPublicProxyPool
      const { result: scrape } = await refresh({
        limit: options?.proxyLimit ?? DEFAULT_PUBLIC_PROXY_TARGET,
      })
      state.proxyCount = scrape.kept
      state.lastProxyRefreshAt = scrape.fetchedAt
      result.proxy = {
        kept: scrape.kept,
        sourcesOk: scrape.sourcesOk,
        sourcesAttempted: scrape.sourcesAttempted,
        errors: scrape.errors.slice(0, 5),
      }
      logs.push(
        `Proxy pool ready: ${scrape.kept} nodes from ${scrape.sourcesOk}/${scrape.sourcesAttempted} sources.`,
      )
    } catch (error) {
      logs.push(
        `Proxy scrape failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (collectPocs) {
    logs.push('Collecting PoC / n-day references silently…')
    try {
      const ensure =
        options?.ensurePocCatalog ?? defaultEnsurePocCatalog
      const poc = await ensure()
      state.pocCount = poc.total
      state.lastPocRefreshAt = nowIso
      result.poc = poc
      // Deliberately do NOT list individual CVE ids in logs — user asked for silent collection.
      logs.push(`PoC catalog ready: ${poc.total} scope-gated references indexed.`)
    } catch (error) {
      logs.push(
        `PoC collection failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  saveFirstRunState(state)
  return result
}

async function defaultEnsurePocCatalog(): Promise<{ total: number; path: string }> {
  // Prefer existing workspace catalog; if thin, shell out to generator.
  const existing = loadPocCatalog()
  const path = getPocCatalogPath()
  if (existing && existing.entries.length >= 100) {
    return { total: existing.entries.length, path }
  }
  // Run generator in-process via dynamic import of the script's data path:
  // spawn bun to avoid bundling the whole generator into the CLI critical path.
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'bun',
      ['run', 'scripts/gen-poc-catalog.ts'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`gen-poc-catalog exited ${code}`))
    })
  })
  const again = loadPocCatalog()
  const total = again?.entries.length ?? 0
  return { total, path }
}

/** Status line helper for HUD / autonomy deep status. */
export function formatFirstRunStatus(state: FirstRunState | null): string {
  if (!state || !state.completedAt) {
    return 'First-run: pending (proxy scrape + PoC collection not decided)'
  }
  const bits = [
    `First-run: completed ${state.completedAt.slice(0, 19)}`,
    state.scrapeProxies
      ? `proxies=${state.proxyCount ?? '?'} (last ${state.lastProxyRefreshAt?.slice(0, 19) ?? 'n/a'})`
      : 'proxies=skipped',
    state.collectPocs
      ? `pocs=${state.pocCount ?? summarizePocCatalog(loadPocCatalog()).total}`
      : 'pocs=skipped',
  ]
  return bits.join(' · ')
}
