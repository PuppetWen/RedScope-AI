/**
 * Authorized egress pool rotation engine.
 *
 * RedScope advertises "IP switching" for authorized red-team exercises: the
 * referee provides a pool of approved egress nodes (see
 * `tools/authorized-egress.referee-provided.json`) and RedScope may health-check
 * and rotate through them. Until now only the *config file* was provisioned
 * (see `authorizedEgressConfig.ts`) — nothing actually parsed the pool, picked a
 * node, honored the switch policy, or tracked cooldowns. This module is that
 * missing engine.
 *
 * Design constraints, taken straight from the pool policy:
 *   - `requireAuthorization`: a pool with no authorization block is refused.
 *   - `disallowPublicFreeProxies`: this engine NEVER augments the pool with
 *     scraped/public proxies. It only ever selects from referee-provided nodes.
 *   - Rotation is least-recently-used with optional per-target avoidance, a
 *     bounded number of auto-switches per step, and a blocked-node cooldown.
 *
 * Everything here is pure and synchronous so it can be unit-tested without IO;
 * the thin file loaders at the bottom wrap it for runtime use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  getExistingRefereeEgressConfigFilePath,
  REFEREE_EGRESS_STATE_FILE,
} from './authorizedEgressConfig.js'
import { getPreferredUserConfigFile } from './redscopeCompat.js'

export type EgressProtocol = 'http' | 'https' | 'socks4' | 'socks5'

export type EgressNode = {
  id: string
  name?: string
  endpoint: string
  protocol: EgressProtocol
  host: string
  port: number
  sourceIp?: string
  provider?: string
  region?: string
  approvedBy?: string
  approvalReference?: string
  enabled: boolean
}

export type EgressAuthorization = {
  authorizedBy?: string
  reference?: string
  validFrom?: string
  validTo?: string
}

export type EgressPool = {
  id: string
  name?: string
  owner?: string
  authorization?: EgressAuthorization
  rateLimits?: { requestsPerSecond?: number; concurrency?: number }
  nodes: EgressNode[]
}

export type EgressPolicy = {
  requireAuthorization: boolean
  disallowPublicFreeProxies: boolean
  disallowUnverifiedNodes: boolean
  autoUseForAuthorizedTesting: boolean
  defaultPoolId?: string
  maxAutoSwitchesPerStep: number
  switchOnHttpStatuses: number[]
  validateBeforeUse: boolean
  connectivityCheckTimeoutMs: number
  avoidPreviouslyUsedNodesPerTarget: boolean
  defaultRefreshIntervalDays: number
  blockedCooldownHours: number
  statePath?: string
  notes?: string[]
}

export type EgressConfig = {
  schemaVersion?: number
  policy: EgressPolicy
  egressPools: EgressPool[]
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  requireAuthorization: true,
  disallowPublicFreeProxies: true,
  disallowUnverifiedNodes: true,
  autoUseForAuthorizedTesting: true,
  maxAutoSwitchesPerStep: 8,
  switchOnHttpStatuses: [403, 407, 429, 451],
  validateBeforeUse: true,
  connectivityCheckTimeoutMs: 3000,
  avoidPreviouslyUsedNodesPerTarget: true,
  defaultRefreshIntervalDays: 1,
  blockedCooldownHours: 24,
}

const ENDPOINT_RE = /^([a-z0-9]+):\/\/([^:/?#\s]+):(\d{1,5})$/i

/**
 * Parse a `scheme://host:port` endpoint. Returns null for anything that isn't a
 * supported proxy protocol with an explicit port, so malformed nodes are
 * dropped rather than silently treated as direct connections.
 */
export function parseEgressEndpoint(endpoint: string): {
  protocol: EgressProtocol
  host: string
  port: number
} | null {
  const match = ENDPOINT_RE.exec(endpoint.trim())
  if (!match) return null
  const scheme = match[1]!.toLowerCase()
  if (
    scheme !== 'http' &&
    scheme !== 'https' &&
    scheme !== 'socks4' &&
    scheme !== 'socks5'
  ) {
    return null
  }
  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { protocol: scheme, host: match[2]!, port }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizePolicy(raw: unknown): EgressPolicy {
  const p = (raw ?? {}) as Record<string, unknown>
  const statuses = Array.isArray(p.switchOnHttpStatuses)
    ? p.switchOnHttpStatuses.filter(
        (s): s is number => typeof s === 'number' && Number.isInteger(s),
      )
    : DEFAULT_EGRESS_POLICY.switchOnHttpStatuses
  return {
    requireAuthorization: asBoolean(
      p.requireAuthorization,
      DEFAULT_EGRESS_POLICY.requireAuthorization,
    ),
    disallowPublicFreeProxies: asBoolean(
      p.disallowPublicFreeProxies,
      DEFAULT_EGRESS_POLICY.disallowPublicFreeProxies,
    ),
    disallowUnverifiedNodes: asBoolean(
      p.disallowUnverifiedNodes,
      DEFAULT_EGRESS_POLICY.disallowUnverifiedNodes,
    ),
    autoUseForAuthorizedTesting: asBoolean(
      p.autoUseForAuthorizedTesting,
      DEFAULT_EGRESS_POLICY.autoUseForAuthorizedTesting,
    ),
    defaultPoolId:
      typeof p.defaultPoolId === 'string' ? p.defaultPoolId : undefined,
    maxAutoSwitchesPerStep: Math.max(
      0,
      Math.floor(
        asNumber(
          p.maxAutoSwitchesPerStep,
          DEFAULT_EGRESS_POLICY.maxAutoSwitchesPerStep,
        ),
      ),
    ),
    switchOnHttpStatuses: statuses,
    validateBeforeUse: asBoolean(
      p.validateBeforeUse,
      DEFAULT_EGRESS_POLICY.validateBeforeUse,
    ),
    connectivityCheckTimeoutMs: Math.max(
      0,
      asNumber(
        p.connectivityCheckTimeoutMs,
        DEFAULT_EGRESS_POLICY.connectivityCheckTimeoutMs,
      ),
    ),
    avoidPreviouslyUsedNodesPerTarget: asBoolean(
      p.avoidPreviouslyUsedNodesPerTarget,
      DEFAULT_EGRESS_POLICY.avoidPreviouslyUsedNodesPerTarget,
    ),
    defaultRefreshIntervalDays: asNumber(
      p.defaultRefreshIntervalDays,
      DEFAULT_EGRESS_POLICY.defaultRefreshIntervalDays,
    ),
    blockedCooldownHours: Math.max(
      0,
      asNumber(
        p.blockedCooldownHours,
        DEFAULT_EGRESS_POLICY.blockedCooldownHours,
      ),
    ),
    statePath: typeof p.statePath === 'string' ? p.statePath : undefined,
    notes: Array.isArray(p.notes)
      ? p.notes.filter((n): n is string => typeof n === 'string')
      : undefined,
  }
}

function normalizeNode(raw: unknown): EgressNode | null {
  const n = (raw ?? {}) as Record<string, unknown>
  if (typeof n.id !== 'string' || typeof n.endpoint !== 'string') return null
  const parsed = parseEgressEndpoint(n.endpoint)
  if (!parsed) return null
  return {
    id: n.id,
    name: typeof n.name === 'string' ? n.name : undefined,
    endpoint: n.endpoint.trim(),
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    sourceIp: typeof n.sourceIp === 'string' ? n.sourceIp : parsed.host,
    provider: typeof n.provider === 'string' ? n.provider : undefined,
    region: typeof n.region === 'string' ? n.region : undefined,
    approvedBy: typeof n.approvedBy === 'string' ? n.approvedBy : undefined,
    approvalReference:
      typeof n.approvalReference === 'string' ? n.approvalReference : undefined,
    // Nodes are opt-out: absent `enabled` means enabled, matching the template.
    enabled: n.enabled !== false,
  }
}

function normalizePool(raw: unknown): EgressPool | null {
  const p = (raw ?? {}) as Record<string, unknown>
  if (typeof p.id !== 'string') return null
  const nodes = Array.isArray(p.nodes)
    ? p.nodes
        .map(normalizeNode)
        .filter((node): node is EgressNode => node !== null)
    : []
  const auth = (p.authorization ?? undefined) as
    | Record<string, unknown>
    | undefined
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : undefined,
    owner: typeof p.owner === 'string' ? p.owner : undefined,
    authorization: auth
      ? {
          authorizedBy:
            typeof auth.authorizedBy === 'string'
              ? auth.authorizedBy
              : undefined,
          reference:
            typeof auth.reference === 'string' ? auth.reference : undefined,
          validFrom:
            typeof auth.validFrom === 'string' ? auth.validFrom : undefined,
          validTo: typeof auth.validTo === 'string' ? auth.validTo : undefined,
        }
      : undefined,
    rateLimits: (p.rateLimits ?? undefined) as EgressPool['rateLimits'],
    nodes,
  }
}

/**
 * Validate + fill defaults on a raw parsed config object. Invalid nodes/pools
 * are dropped rather than throwing, so one bad entry can't disable the feature.
 */
export function normalizeEgressConfig(raw: unknown): EgressConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const pools = Array.isArray(r.egressPools)
    ? r.egressPools
        .map(normalizePool)
        .filter((pool): pool is EgressPool => pool !== null)
    : []
  return {
    schemaVersion:
      typeof r.schemaVersion === 'number' ? r.schemaVersion : undefined,
    policy: normalizePolicy(r.policy),
    egressPools: pools,
  }
}

// ---------------------------------------------------------------------------
// Rotation state
// ---------------------------------------------------------------------------

export type EgressNodeRuntime = {
  id: string
  lastUsedAtMs?: number
  blockedUntilMs?: number
  failureCount: number
  successCount: number
  usedTargets: string[]
}

export type EgressRotationState = {
  poolId?: string
  activeNodeId?: string
  switchesThisStep: number
  stepStartedAtMs?: number
  nodes: Record<string, EgressNodeRuntime>
}

export function createEgressRotationState(
  poolId?: string,
): EgressRotationState {
  return {
    poolId,
    activeNodeId: undefined,
    switchesThisStep: 0,
    stepStartedAtMs: undefined,
    nodes: {},
  }
}

function runtimeFor(
  state: EgressRotationState,
  nodeId: string,
): EgressNodeRuntime {
  const existing = state.nodes[nodeId]
  if (existing) return existing
  const created: EgressNodeRuntime = {
    id: nodeId,
    failureCount: 0,
    successCount: 0,
    usedTargets: [],
  }
  state.nodes[nodeId] = created
  return created
}

export function resolveEgressPool(
  config: EgressConfig,
  poolId?: string,
): EgressPool | null {
  const wanted = poolId ?? config.policy.defaultPoolId
  if (wanted) {
    const match = config.egressPools.find(pool => pool.id === wanted)
    if (match) return match
  }
  return config.egressPools[0] ?? null
}

export function poolIsAuthorized(pool: EgressPool): boolean {
  const auth = pool.authorization
  return Boolean(auth && (auth.authorizedBy || auth.reference))
}

export type EgressSelectionOutcome =
  | { ok: true; node: EgressNode; reason: 'selected' }
  | {
      ok: false
      node: null
      reason: 'no-pool' | 'unauthorized' | 'no-enabled-nodes' | 'all-blocked'
    }

function isBlocked(
  runtime: EgressNodeRuntime | undefined,
  nowMs: number,
): boolean {
  return Boolean(
    runtime?.blockedUntilMs !== undefined && runtime.blockedUntilMs > nowMs,
  )
}

/**
 * Pick the next egress node for an authorized request. Mutates `state` to record
 * the selection (last-used time, per-target history, active node). Returns the
 * node plus a machine-readable reason so callers can surface *why* nothing was
 * selected instead of silently going direct.
 */
export function selectEgressNode(params: {
  config: EgressConfig
  state: EgressRotationState
  poolId?: string
  target?: string
  nowMs: number
}): EgressSelectionOutcome {
  const { config, state, poolId, target, nowMs } = params
  const pool = resolveEgressPool(config, poolId)
  if (!pool) return { ok: false, node: null, reason: 'no-pool' }

  if (config.policy.requireAuthorization && !poolIsAuthorized(pool)) {
    return { ok: false, node: null, reason: 'unauthorized' }
  }

  state.poolId = pool.id
  const enabled = pool.nodes.filter(node => node.enabled)
  if (enabled.length === 0) {
    return { ok: false, node: null, reason: 'no-enabled-nodes' }
  }

  const available = enabled.filter(
    node => !isBlocked(state.nodes[node.id], nowMs),
  )
  if (available.length === 0) {
    return { ok: false, node: null, reason: 'all-blocked' }
  }

  // Prefer nodes not yet used against this target, when the policy asks for it.
  let candidates = available
  if (config.policy.avoidPreviouslyUsedNodesPerTarget && target) {
    const fresh = available.filter(
      node => !(state.nodes[node.id]?.usedTargets.includes(target) ?? false),
    )
    if (fresh.length > 0) candidates = fresh
  }

  // Least-recently-used wins; unused nodes (no lastUsedAtMs) sort first. Stable
  // id tie-break keeps selection deterministic for tests and audit logs.
  const chosen = candidates.slice().sort((a, b) => {
    const la = state.nodes[a.id]?.lastUsedAtMs ?? -1
    const lb = state.nodes[b.id]?.lastUsedAtMs ?? -1
    if (la !== lb) return la - lb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })[0]!

  const runtime = runtimeFor(state, chosen.id)
  runtime.lastUsedAtMs = nowMs
  if (target && !runtime.usedTargets.includes(target)) {
    runtime.usedTargets.push(target)
  }
  state.activeNodeId = chosen.id
  return { ok: true, node: chosen, reason: 'selected' }
}

/** Reset the per-step auto-switch counter. Call at the start of each tool step. */
export function beginEgressStep(
  state: EgressRotationState,
  nowMs: number,
): EgressRotationState {
  state.switchesThisStep = 0
  state.stepStartedAtMs = nowMs
  return state
}

/**
 * Decide whether an HTTP response status should trigger an auto-switch to a new
 * egress node, honoring both the status allowlist and the per-step cap.
 */
export function shouldSwitchEgress(params: {
  policy: EgressPolicy
  httpStatus: number
  state: EgressRotationState
}): boolean {
  const { policy, httpStatus, state } = params
  if (!policy.switchOnHttpStatuses.includes(httpStatus)) return false
  return state.switchesThisStep < policy.maxAutoSwitchesPerStep
}

/** Record that a switch happened (increments the per-step counter). */
export function markEgressSwitch(
  state: EgressRotationState,
): EgressRotationState {
  state.switchesThisStep += 1
  return state
}

/**
 * Record the result of using a node. Failures and blocking statuses put the node
 * on cooldown so rotation naturally avoids it until it recovers.
 */
export function recordEgressResult(params: {
  policy: EgressPolicy
  state: EgressRotationState
  nodeId: string
  ok: boolean
  httpStatus?: number
  nowMs: number
}): EgressRotationState {
  const { policy, state, nodeId, ok, httpStatus, nowMs } = params
  const runtime = runtimeFor(state, nodeId)
  const blockingStatus =
    httpStatus !== undefined && policy.switchOnHttpStatuses.includes(httpStatus)
  if (ok && !blockingStatus) {
    runtime.successCount += 1
    return state
  }
  runtime.failureCount += 1
  runtime.blockedUntilMs = nowMs + policy.blockedCooldownHours * 3_600_000
  return state
}

// ---------------------------------------------------------------------------
// Status summary (for the HUD / `autonomy status`)
// ---------------------------------------------------------------------------

export type EgressStatusSummary = {
  configured: boolean
  poolId?: string
  poolName?: string
  authorized: boolean
  totalNodes: number
  enabledNodes: number
  blockedNodes: number
  activeNodeId?: string
  activeIp?: string
  activeEndpoint?: string
  switchesThisStep: number
  maxAutoSwitchesPerStep: number
}

export function summarizeEgress(params: {
  config: EgressConfig | null
  state: EgressRotationState
  poolId?: string
  nowMs: number
}): EgressStatusSummary {
  const { config, state, poolId, nowMs } = params
  if (!config) {
    return {
      configured: false,
      authorized: false,
      totalNodes: 0,
      enabledNodes: 0,
      blockedNodes: 0,
      switchesThisStep: state.switchesThisStep,
      maxAutoSwitchesPerStep: DEFAULT_EGRESS_POLICY.maxAutoSwitchesPerStep,
    }
  }
  const pool = resolveEgressPool(config, poolId ?? state.poolId)
  const nodes = pool?.nodes ?? []
  const enabled = nodes.filter(node => node.enabled)
  const blocked = enabled.filter(node => isBlocked(state.nodes[node.id], nowMs))
  const active = state.activeNodeId
    ? nodes.find(node => node.id === state.activeNodeId)
    : undefined
  return {
    configured: true,
    poolId: pool?.id,
    poolName: pool?.name,
    authorized: pool ? poolIsAuthorized(pool) : false,
    totalNodes: nodes.length,
    enabledNodes: enabled.length,
    blockedNodes: blocked.length,
    activeNodeId: active?.id,
    activeIp: active?.sourceIp ?? active?.host,
    activeEndpoint: active?.endpoint,
    switchesThisStep: state.switchesThisStep,
    maxAutoSwitchesPerStep: config.policy.maxAutoSwitchesPerStep,
  }
}

export function formatEgressStatus(summary: EgressStatusSummary): string {
  if (!summary.configured) {
    return [
      'Egress pool: not configured',
      '  add ~/.redscope/authorized-egress.referee-provided.json to enable IP rotation',
    ].join('\n')
  }
  const active = summary.activeIp
    ? `${summary.activeIp}${
        summary.activeEndpoint ? ` (${summary.activeEndpoint})` : ''
      }`
    : 'none selected'
  return [
    `Egress pool: ${summary.poolName ?? summary.poolId ?? 'unknown'} ${
      summary.authorized ? 'authorized' : 'UNAUTHORIZED'
    }`,
    `  nodes=${summary.enabledNodes}/${summary.totalNodes} enabled blocked=${summary.blockedNodes}`,
    `  active=${active}`,
    `  switches=${summary.switchesThisStep}/${summary.maxAutoSwitchesPerStep} this step`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Thin IO wrappers (kept out of the pure core above for testability)
// ---------------------------------------------------------------------------

/**
 * Load and normalize an egress config. Preference order:
 *   1. Explicit env REDSCOPE_EGRESS_CONFIG / REDSCOPE_TOOLS_EGRESS_CONFIG
 *   2. Public free-proxy pool (when the user opted in via first-run / scrape)
 *   3. Referee-provided authorized egress config
 *
 * Returns null when nothing usable is on disk.
 */
export function loadEgressConfig(): EgressConfig | null {
  const envPath =
    process.env.REDSCOPE_EGRESS_CONFIG ??
    process.env.REDSCOPE_TOOLS_EGRESS_CONFIG
  const candidates = [
    envPath,
    // Public free-proxy pool written by first-run / redscope:proxy-scrape
    getPreferredUserConfigFile('public-free-proxies.json'),
    // Workspace copy next to the engagement
    `${process.cwd().replace(/\\/g, '/')}/public-free-proxies.json`,
    getExistingRefereeEgressConfigFilePath(),
  ].filter((p): p is string => Boolean(p))

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      const config = normalizeEgressConfig(raw)
      if (config.egressPools.some(pool => pool.nodes.length > 0)) {
        return config
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

export function getEgressStatePath(config: EgressConfig | null): string {
  const configured = config?.policy.statePath
  if (configured) return configured
  return getPreferredUserConfigFile(REFEREE_EGRESS_STATE_FILE)
}

export function loadEgressRotationState(
  statePath: string,
): EgressRotationState {
  if (!existsSync(statePath)) return createEgressRotationState()
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
    const nodes =
      raw &&
      typeof raw === 'object' &&
      raw.nodes &&
      typeof raw.nodes === 'object'
        ? (raw.nodes as Record<string, EgressNodeRuntime>)
        : {}
    return {
      poolId: typeof raw?.poolId === 'string' ? raw.poolId : undefined,
      activeNodeId:
        typeof raw?.activeNodeId === 'string' ? raw.activeNodeId : undefined,
      switchesThisStep:
        typeof raw?.switchesThisStep === 'number' ? raw.switchesThisStep : 0,
      stepStartedAtMs:
        typeof raw?.stepStartedAtMs === 'number'
          ? raw.stepStartedAtMs
          : undefined,
      nodes,
    }
  } catch {
    return createEgressRotationState()
  }
}

/**
 * Persist rotation state so auto-switches survive process restarts. Creates the
 * parent directory when needed. Never throws to callers — disk failures are
 * reported via the return value so a flaky state file cannot abort a tool step.
 */
export function saveEgressRotationState(
  statePath: string,
  state: EgressRotationState,
): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Convenience: select a node and immediately persist the mutated rotation state.
 * Callers that already batch writes can keep using `selectEgressNode` +
 * `saveEgressRotationState` separately.
 */
export function selectAndPersistEgressNode(params: {
  config: EgressConfig
  state: EgressRotationState
  statePath: string
  poolId?: string
  target?: string
  nowMs: number
}): EgressSelectionOutcome & {
  persisted: boolean
  persistError?: string
} {
  const outcome = selectEgressNode(params)
  if (!outcome.ok) {
    return { ...outcome, persisted: false }
  }
  const saved = saveEgressRotationState(params.statePath, params.state)
  return {
    ...outcome,
    persisted: saved.ok,
    persistError: saved.ok ? undefined : saved.error,
  }
}

/**
 * Apply a health-check result to a node and persist. Healthy nodes stay available;
 * unhealthy ones are put on the policy cooldown so rotation naturally avoids them.
 */
export function applyEgressHealthResult(params: {
  policy: EgressPolicy
  state: EgressRotationState
  statePath: string
  nodeId: string
  healthy: boolean
  httpStatus?: number
  nowMs: number
}): {
  state: EgressRotationState
  persisted: boolean
  persistError?: string
} {
  recordEgressResult({
    policy: params.policy,
    state: params.state,
    nodeId: params.nodeId,
    ok: params.healthy,
    httpStatus: params.httpStatus,
    nowMs: params.nowMs,
  })
  const saved = saveEgressRotationState(params.statePath, params.state)
  return {
    state: params.state,
    persisted: saved.ok,
    persistError: saved.ok ? undefined : saved.error,
  }
}
