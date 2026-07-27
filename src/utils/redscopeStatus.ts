/**
 * Aggregates the security-relevant state RedScope should surface in the
 * conversation UI (and headless `autonomy status`): the active goal, whether
 * autonomy is engaged, the authorized egress/IP state, the engagement recon
 * summary, and the PoC reference count.
 *
 * The assembly + formatting are pure (testable); the runtime accessor at the
 * bottom reads live snapshots and caches the file-backed pieces so it can be
 * called every render without thrashing disk.
 */

import {
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
} from './permissions/permissionSetup.js'
import { getGoalModeSnapshot } from './goalMode.js'
import {
  loadEgressConfig,
  loadEgressRotationState,
  getEgressStatePath,
  summarizeEgress,
  type EgressStatusSummary,
} from './egressPool.js'
import {
  loadEngagementGraph,
  summarizeEngagement,
  type EngagementSummary,
} from './engagementGraph.js'
import {
  loadPocCatalog,
  summarizePocCatalog,
  type PocCatalogSummary,
} from './pocCatalog.js'
import {
  getFirstRunPrompt,
  loadFirstRunState,
  type FirstRunState,
} from './firstRunSetup.js'
import { loadPublicProxyPool } from './publicProxyPool.js'
import { detectNuclei, type NucleiPresence } from './nucleiTool.js'

export type StatusTone = 'goal' | 'ok' | 'warn' | 'danger' | 'active' | 'dim'

export type RedscopeStatusRow = {
  id: string
  icon: string
  label: string
  value: string
  tone: StatusTone
}

export type AutonomyAvailability = {
  available: boolean
  reason: string | null
}

export type RedscopeStatusModel = {
  goal: {
    objective: string
    iterations: number
    elapsedMs: number
  } | null
  autonomy: AutonomyAvailability
  egress: EgressStatusSummary
  engagement: EngagementSummary
  poc: PocCatalogSummary
  firstRun: {
    needed: boolean
    completed: boolean
    proxyCount: number
    pocCount: number
  }
  nuclei: NucleiPresence | null
}

/**
 * The status HUD is an entry-screen overview, not persistent conversation
 * chrome. System/progress messages may exist during startup, so only a real
 * user or assistant turn marks the conversation as started.
 */
export function shouldShowRedscopeStatusHud(
  messages: ReadonlyArray<{ type: string }>,
): boolean {
  return !messages.some(
    message => message.type === 'user' || message.type === 'assistant',
  )
}

export function buildAutonomyAvailability(
  gateEnabled: boolean,
  reason: string | null,
): AutonomyAvailability {
  return { available: gateEnabled && reason === null, reason }
}

export function formatElapsed(ms: number): string {
  const clamped = ms < 0 ? 0 : ms
  const s = Math.floor(clamped / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * Turn the aggregated model into display rows. Rows for a subsystem that has no
 * meaningful state (no goal, no egress config, no hosts, no PoC refs) are
 * omitted so the HUD stays compact.
 */
export function buildRedscopeStatusRows(
  model: RedscopeStatusModel,
): RedscopeStatusRow[] {
  const rows: RedscopeStatusRow[] = []

  if (model.goal) {
    rows.push({
      id: 'goal',
      icon: '◎',
      label: 'Goal',
      value: `${model.goal.objective} · iter ${model.goal.iterations} · ${formatElapsed(
        model.goal.elapsedMs,
      )}`,
      tone: 'goal',
    })
  }

  rows.push({
    id: 'autonomy',
    icon: '⚡',
    label: 'Autonomy',
    value: model.autonomy.available
      ? 'engaged · runs until objective complete'
      : `paused · ${model.autonomy.reason ?? 'unavailable'}`,
    tone: model.autonomy.available ? 'ok' : 'warn',
  })

  const eng = model.engagement
  if (eng.present) {
    const sev = eng.bySeverity
    const devicePart = eng.devices > 0 ? ` · ${eng.devices} net-dev` : ''
    rows.push({
      id: 'recon',
      icon: '☍',
      label: 'Recon',
      value: `${eng.findings} findings (crit ${sev.critical}, high ${sev.high}) · exploited ${eng.exploited} · ${eng.hosts} nodes${devicePart} · zones ${eng.byZone.external}/${eng.byZone.dmz}/${eng.byZone.internal} · ${eng.edges} links · avg ${eng.avgProgress}%`,
      tone: sev.critical > 0 || eng.exploited > 0 ? 'danger' : 'active',
    })
    if (eng.activeTargets.length > 0) {
      const shown = eng.activeTargets.slice(0, 4).join(', ')
      const more =
        eng.activeTargets.length > 4 ? ` +${eng.activeTargets.length - 4}` : ''
      rows.push({
        id: 'targets',
        icon: '⦿',
        label: 'Under test',
        value: `${shown}${more}`,
        tone: 'active',
      })
    }
  }

  const egr = model.egress
  if (egr.configured) {
    rows.push({
      id: 'egress',
      icon: '⇄',
      label: 'Egress IP',
      value: `${egr.activeIp ?? 'idle'} · ${egr.enabledNodes}/${egr.totalNodes} nodes${
        egr.blockedNodes > 0 ? ` (${egr.blockedNodes} cooling)` : ''
      } · ${egr.poolName ?? egr.poolId ?? 'pool'} · switch ${egr.switchesThisStep}/${egr.maxAutoSwitchesPerStep}`,
      tone: egr.authorized ? 'ok' : 'danger',
    })
  }

  if (model.poc.present && model.poc.total > 0) {
    rows.push({
      id: 'poc',
      // `☰` is rendered two columns wide by Windows Terminal but measured as
      // one by Yoga, clipping the final character of "PoC refs".
      icon: '≡',
      label: 'PoC refs',
      value: `${model.poc.total} indexed (${model.poc.scopeGated} scope-gated)`,
      tone: 'dim',
    })
  }

  if (model.firstRun.needed) {
    rows.push({
      id: 'first-run',
      icon: '①',
      label: 'Setup',
      value: 'pending · bun run redscope:first-run',
      tone: 'warn',
    })
  } else if (model.firstRun.completed && model.firstRun.proxyCount > 0) {
    rows.push({
      id: 'proxy-pool',
      icon: '⇄',
      label: 'Pub IPs',
      value: `${model.firstRun.proxyCount} free-proxy nodes · silent rotate on fail`,
      tone: 'ok',
    })
  }

  if (model.nuclei) {
    rows.push({
      id: 'nuclei',
      icon: model.nuclei.available ? '▣' : '□',
      label: 'Nuclei',
      value: model.nuclei.available
        ? `${model.nuclei.version ?? 'ready'} · ${model.nuclei.source}${
            model.nuclei.binaryPath
              ? ` · ${model.nuclei.binaryPath.replace(/\\/g, '/').split('/').at(-1)}`
              : ''
          }`
        : 'missing · bun run redscope:nuclei-setup',
      tone: model.nuclei.available ? 'ok' : 'warn',
    })
  }

  return rows
}

/**
 * Condensed rows for terminals where a full subsystem-by-subsystem panel would
 * consume too much of the conversation viewport. The same state is retained,
 * but related metrics are grouped into operation, network, and capability
 * summaries.
 */
export function buildRedscopeCompactStatusRows(
  model: RedscopeStatusModel,
): RedscopeStatusRow[] {
  const rows: RedscopeStatusRow[] = []
  const engagement = model.engagement
  const operationParts = [
    model.autonomy.available
      ? 'autonomy active'
      : `autonomy paused${model.autonomy.reason ? ` (${model.autonomy.reason})` : ''}`,
  ]

  if (engagement.present) {
    if (engagement.bySeverity.critical > 0) {
      operationParts.push(`${engagement.bySeverity.critical} critical`)
    }
    if (engagement.exploited > 0) {
      operationParts.push(`${engagement.exploited} exploited`)
    }
    operationParts.push(
      `${engagement.findings} findings`,
      `${engagement.hosts} nodes`,
    )
  }

  rows.push({
    id: 'operation',
    icon: '◆',
    label: 'Operation',
    value: operationParts.join(' · '),
    tone:
      engagement.present &&
      (engagement.bySeverity.critical > 0 || engagement.exploited > 0)
        ? 'danger'
        : model.autonomy.available
          ? 'active'
          : 'warn',
  })

  const egress = model.egress
  if (egress.configured) {
    rows.push({
      id: 'network',
      icon: '⇄',
      label: 'Network',
      value: `egress ${egress.activeIp ?? 'idle'} · ${egress.enabledNodes}/${egress.totalNodes} nodes${
        egress.blockedNodes > 0 ? ` · ${egress.blockedNodes} cooling` : ''
      }`,
      tone: egress.authorized ? 'ok' : 'danger',
    })
  }

  const capabilityParts: string[] = []
  if (model.poc.present && model.poc.total > 0) {
    capabilityParts.push(`${model.poc.total} PoCs`)
  }
  if (model.nuclei) {
    capabilityParts.push(
      model.nuclei.available ? 'Nuclei ready' : 'Nuclei missing',
    )
  }
  if (model.firstRun.needed) {
    capabilityParts.push('setup pending')
  } else if (model.firstRun.proxyCount > 0) {
    capabilityParts.push(`${model.firstRun.proxyCount} proxy nodes`)
  }
  if (capabilityParts.length > 0) {
    rows.push({
      id: 'capabilities',
      icon: '◇',
      label: 'Capability',
      value: capabilityParts.join(' · '),
      tone:
        model.firstRun.needed ||
        (model.nuclei !== null && !model.nuclei.available)
          ? 'warn'
          : 'dim',
    })
  }

  return rows
}

export function formatRedscopeStatusLines(
  model: RedscopeStatusModel,
): string[] {
  return buildRedscopeStatusRows(model).map(
    row => `${row.icon} ${row.label}: ${row.value}`,
  )
}

// ---------------------------------------------------------------------------
// Runtime accessor (cached file reads)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 3000
const NUCLEI_CACHE_TTL_MS = 15_000

type Cached<T> = { at: number; value: T }
let egressCache: Cached<EgressStatusSummary> | null = null
let engagementCache: Cached<EngagementSummary> | null = null
let pocCache: Cached<PocCatalogSummary> | null = null
let nucleiCache: Cached<NucleiPresence | null> | null = null
let firstRunCache: Cached<RedscopeStatusModel['firstRun']> | null = null

function fresh<T>(cache: Cached<T> | null, nowMs: number): cache is Cached<T> {
  return cache !== null && nowMs - cache.at < CACHE_TTL_MS
}

function getEgressSummaryCached(nowMs: number): EgressStatusSummary {
  if (fresh(egressCache, nowMs)) return egressCache.value
  let value: EgressStatusSummary
  try {
    const config = loadEgressConfig()
    const state = config
      ? loadEgressRotationState(getEgressStatePath(config))
      : loadEgressRotationState(getEgressStatePath(null))
    value = summarizeEgress({ config, state, nowMs })
  } catch {
    value = summarizeEgress({
      config: null,
      state: loadEgressRotationState(getEgressStatePath(null)),
      nowMs,
    })
  }
  egressCache = { at: nowMs, value }
  return value
}

function getEngagementSummaryCached(nowMs: number): EngagementSummary {
  if (fresh(engagementCache, nowMs)) return engagementCache.value
  let value: EngagementSummary
  try {
    value = summarizeEngagement(loadEngagementGraph())
  } catch {
    value = summarizeEngagement(null)
  }
  engagementCache = { at: nowMs, value }
  return value
}

function getPocSummaryCached(nowMs: number): PocCatalogSummary {
  if (fresh(pocCache, nowMs)) return pocCache.value
  let value: PocCatalogSummary
  try {
    value = summarizePocCatalog(loadPocCatalog())
  } catch {
    value = summarizePocCatalog(null)
  }
  pocCache = { at: nowMs, value }
  return value
}

/** Drop cached file-backed summaries (used by tests and after known writes). */
export function invalidateRedscopeStatusCache(): void {
  egressCache = null
  engagementCache = null
  pocCache = null
  nucleiCache = null
  firstRunCache = null
}

function getAutonomyAvailability(): AutonomyAvailability {
  try {
    return buildAutonomyAvailability(
      isAutoModeGateEnabled(),
      getAutoModeUnavailableReason(),
    )
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'unknown',
    }
  }
}

function getFirstRunSnapshot(nowMs: number): RedscopeStatusModel['firstRun'] {
  if (fresh(firstRunCache, nowMs)) return firstRunCache.value
  let value: RedscopeStatusModel['firstRun']
  try {
    const prompt = getFirstRunPrompt()
    const state: FirstRunState | null = loadFirstRunState()
    const publicPool = loadPublicProxyPool()
    const proxyCount =
      state?.proxyCount ??
      publicPool?.egressPools.reduce((n, p) => n + p.nodes.length, 0) ??
      0
    const pocCount = state?.pocCount ?? getPocSummaryCached(nowMs).total
    value = {
      needed: prompt.needed,
      completed: Boolean(state?.completedAt),
      proxyCount,
      pocCount,
    }
  } catch {
    value = { needed: false, completed: false, proxyCount: 0, pocCount: 0 }
  }
  firstRunCache = { at: nowMs, value }
  return value
}

function getNucleiSnapshot(nowMs = Date.now()): NucleiPresence | null {
  if (nucleiCache !== null && nowMs - nucleiCache.at < NUCLEI_CACHE_TTL_MS) {
    return nucleiCache.value
  }
  let value: NucleiPresence | null
  try {
    value = detectNuclei()
  } catch {
    value = null
  }
  nucleiCache = { at: nowMs, value }
  return value
}

export function getRedscopeStatusModel(
  nowMs = Date.now(),
): RedscopeStatusModel {
  const { activeGoal } = getGoalModeSnapshot()
  return {
    goal: activeGoal
      ? {
          objective: activeGoal.objective,
          iterations: activeGoal.continuationCount,
          elapsedMs: nowMs - activeGoal.startedAt,
        }
      : null,
    autonomy: getAutonomyAvailability(),
    egress: getEgressSummaryCached(nowMs),
    engagement: getEngagementSummaryCached(nowMs),
    poc: getPocSummaryCached(nowMs),
    firstRun: getFirstRunSnapshot(nowMs),
    // Always surface nuclei readiness so the operator knows when to install.
    nuclei: getNucleiSnapshot(nowMs),
  }
}
