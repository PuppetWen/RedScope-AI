/**
 * Silent egress health-check + auto-rotate used during active testing.
 *
 * Flow for each outbound request / test step:
 *   1. Ensure a pool is loaded (public free-proxy pool preferred after first-run)
 *   2. Pick a node (LRU / avoid-per-target)
 *   3. TCP health-check; on failure cool the node and try the next
 *   4. Apply proxy env silently (no console spam)
 *   5. On HTTP block statuses or network errors mid-request, swap and retry
 *
 * Designed so profile runners / autonomy loops can call `withSilentEgress`
 * without the operator babysitting dead free proxies.
 */

import { connect } from 'net'
import {
  applyEgressHealthResult,
  beginEgressStep,
  getEgressStatePath,
  loadEgressConfig,
  loadEgressRotationState,
  markEgressSwitch,
  resolveEgressPool,
  saveEgressRotationState,
  selectEgressNode,
  shouldSwitchEgress,
  type EgressConfig,
  type EgressNode,
  type EgressRotationState,
} from './egressPool.js'
import {
  loadPublicProxyPool,
  getPublicProxyPoolPath,
} from './publicProxyPool.js'
import { invalidateRedscopeStatusCache } from './redscopeStatus.js'

export type SilentEgressSession = {
  enabled: boolean
  config: EgressConfig | null
  state: EgressRotationState
  statePath: string
  activeNode: EgressNode | null
  switches: number
  maxSwitches: number
  target?: string
  /** Quiet event log for manifests / debugging (not printed by default). */
  events: Array<{ at: string; type: string; message: string; nodeId?: string }>
  originalProxyEnv: Record<string, string | undefined>
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

const DEFAULT_BLOCK_STATUSES = [403, 407, 429, 451, 502, 503]

function snapshotProxyEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const key of PROXY_ENV_KEYS) out[key] = process.env[key]
  return out
}

function applyNodeEnv(node: EgressNode): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key]
  const value = node.endpoint
  process.env.HTTP_PROXY = value
  process.env.HTTPS_PROXY = value
  process.env.ALL_PROXY = value
  process.env.http_proxy = value
  process.env.https_proxy = value
  process.env.all_proxy = value
}

function restoreProxyEnv(
  original: Record<string, string | undefined>,
): void {
  for (const key of PROXY_ENV_KEYS) {
    const v = original[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
}

function pushEvent(
  session: SilentEgressSession,
  type: string,
  message: string,
  nodeId?: string,
): void {
  session.events.push({
    at: new Date().toISOString(),
    type,
    message,
    nodeId,
  })
}

export function tcpHealthCheck(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Resolve the best available egress config for silent rotation:
 * public free-proxy pool (first-run / postinstall) → generic loadEgressConfig()
 * (which itself prefers env → public → referee).
 */
export function resolveSilentEgressConfig(): EgressConfig | null {
  const publicPool = loadPublicProxyPool()
  if (publicPool && publicPool.egressPools.some(p => p.nodes.length > 0)) {
    return publicPool
  }
  return loadEgressConfig()
}

export type EnsureSilentEgressOptions = {
  target?: string
  /** Max nodes to health-check while hunting for a live one this call. */
  maxProbes?: number
  timeoutMs?: number
  /** Existing session to continue (preserves switch budget). */
  session?: SilentEgressSession
  nowMs?: number
  /** Injected health check for tests. */
  healthCheck?: typeof tcpHealthCheck
}

/**
 * Ensure process.env points at a *working* proxy. Silently rotates through the
 * pool, cooling dead nodes, until one TCP-connects or the budget is exhausted.
 */
export async function ensureWorkingSilentEgress(
  options: EnsureSilentEgressOptions = {},
): Promise<SilentEgressSession> {
  const nowMs = options.nowMs ?? Date.now()
  const healthCheck = options.healthCheck ?? tcpHealthCheck
  const maxProbes = options.maxProbes ?? 12

  let session = options.session
  if (!session) {
    const config = resolveSilentEgressConfig()
    const statePath = config
      ? getEgressStatePath(config)
      : getPublicProxyPoolPath().replace(/\.json$/, '-state.json')
    const state = loadEgressRotationState(statePath)
    beginEgressStep(state, nowMs)
    session = {
      enabled: Boolean(config && config.egressPools.some(p => p.nodes.length)),
      config,
      state,
      statePath,
      activeNode: null,
      switches: 0,
      maxSwitches: config?.policy.maxAutoSwitchesPerStep ?? 20,
      target: options.target,
      events: [],
      originalProxyEnv: snapshotProxyEnv(),
    }
  } else if (options.target) {
    session.target = options.target
  }

  if (!session.enabled || !session.config) {
    pushEvent(session, 'disabled', 'No egress pool configured')
    return session
  }

  const timeoutMs =
    options.timeoutMs ??
    session.config.policy.connectivityCheckTimeoutMs ??
    2500

  // If current active node still healthy, keep it.
  if (session.activeNode) {
    const ok = await healthCheck(
      session.activeNode.host,
      session.activeNode.port,
      timeoutMs,
    )
    if (ok) {
      applyNodeEnv(session.activeNode)
      return session
    }
    applyEgressHealthResult({
      policy: session.config.policy,
      state: session.state,
      statePath: session.statePath,
      nodeId: session.activeNode.id,
      healthy: false,
      nowMs,
    })
    pushEvent(
      session,
      'unhealthy',
      `Active node failed health-check`,
      session.activeNode.id,
    )
    session.activeNode = null
  }

  for (let i = 0; i < maxProbes; i++) {
    if (session.switches >= session.maxSwitches) break
    const outcome = selectEgressNode({
      config: session.config,
      state: session.state,
      target: session.target,
      nowMs: nowMs + i,
    })
    if (!outcome.ok) {
      pushEvent(session, 'exhausted', `select failed: ${outcome.reason}`)
      break
    }
    const node = outcome.node
    const healthy = await healthCheck(node.host, node.port, timeoutMs)
    applyEgressHealthResult({
      policy: session.config.policy,
      state: session.state,
      statePath: session.statePath,
      nodeId: node.id,
      healthy,
      nowMs: nowMs + i,
    })
    if (!healthy) {
      pushEvent(session, 'probe-fail', `Health-check failed`, node.id)
      session.switches += 1
      markEgressSwitch(session.state)
      continue
    }
    session.activeNode = node
    session.switches += 1
    markEgressSwitch(session.state)
    applyNodeEnv(node)
    saveEgressRotationState(session.statePath, session.state)
    invalidateRedscopeStatusCache()
    pushEvent(
      session,
      'active',
      `Silently using ${node.endpoint}`,
      node.id,
    )
    return session
  }

  saveEgressRotationState(session.statePath, session.state)
  pushEvent(session, 'no-live-node', 'No healthy egress node found this round')
  return session
}

/**
 * After a blocked HTTP status or network failure, cool the active node and
 * silently swap to the next healthy one. Returns true if a new node is active.
 */
export async function silentRotateOnFailure(
  session: SilentEgressSession,
  signal: {
    httpStatus?: number
    reason?: string
    nowMs?: number
    healthCheck?: typeof tcpHealthCheck
    maxProbes?: number
  },
): Promise<boolean> {
  if (!session.enabled || !session.config || !session.activeNode) return false
  const nowMs = signal.nowMs ?? Date.now()
  const status = signal.httpStatus
  if (
    status !== undefined &&
    !shouldSwitchEgress({
      policy: session.config.policy,
      httpStatus: status,
      state: session.state,
    }) &&
    !DEFAULT_BLOCK_STATUSES.includes(status)
  ) {
    // Non-block status — still allow rotation on explicit caller request when
    // reason is set (network error path passes reason without status).
    if (!signal.reason) return false
  }
  applyEgressHealthResult({
    policy: session.config.policy,
    state: session.state,
    statePath: session.statePath,
    nodeId: session.activeNode.id,
    healthy: false,
    httpStatus: status,
    nowMs,
  })
  pushEvent(
    session,
    'rotate',
    signal.reason ?? `block status ${status}`,
    session.activeNode.id,
  )
  session.activeNode = null
  const next = await ensureWorkingSilentEgress({
    session,
    target: session.target,
    nowMs,
    healthCheck: signal.healthCheck,
    maxProbes: signal.maxProbes,
  })
  return Boolean(next.activeNode)
}

export type SilentFetchOptions = {
  target?: string
  maxRetries?: number
  session?: SilentEgressSession
  /** When false, do not rotate on network errors. Default true. */
  rotateOnNetworkError?: boolean
  healthCheck?: typeof tcpHealthCheck
}

/**
 * fetch() wrapper: ensure a live proxy, send the request, on block/network
 * error silently rotate and retry until budget is spent.
 */
export async function fetchWithSilentEgress(
  input: string | URL | Request,
  init: RequestInit = {},
  options: SilentFetchOptions = {},
): Promise<{ response: Response; session: SilentEgressSession }> {
  const maxRetries = options.maxRetries ?? 5
  let session =
    options.session ??
    (await ensureWorkingSilentEgress({
      target: options.target,
      healthCheck: options.healthCheck,
    }))

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!session.activeNode) {
      session = await ensureWorkingSilentEgress({
        session,
        target: options.target,
        healthCheck: options.healthCheck,
      })
      if (!session.activeNode) break
    }
    try {
      const response = await fetch(input, init)
      const blockList =
        session.config?.policy.switchOnHttpStatuses ?? DEFAULT_BLOCK_STATUSES
      if (session.activeNode && blockList.includes(response.status)) {
        if (response.body) {
          await response.body.cancel().catch(() => undefined)
        }
        const rotated = await silentRotateOnFailure(session, {
          httpStatus: response.status,
          reason: `HTTP ${response.status}`,
          healthCheck: options.healthCheck,
        })
        if (rotated) continue
        return { response, session }
      }
      // success path — credit the node
      if (session.activeNode && session.config) {
        applyEgressHealthResult({
          policy: session.config.policy,
          state: session.state,
          statePath: session.statePath,
          nodeId: session.activeNode.id,
          healthy: true,
          httpStatus: response.status,
          nowMs: Date.now(),
        })
      }
      return { response, session }
    } catch (error) {
      lastError = error
      if (options.rotateOnNetworkError === false) throw error
      const rotated = await silentRotateOnFailure(session, {
        reason: `network: ${error instanceof Error ? error.message : String(error)}`,
        healthCheck: options.healthCheck,
      })
      if (!rotated) throw error
    }
  }
  if (lastError) throw lastError
  throw new Error('silent egress: no healthy proxy available')
}

/** Restore process proxy env from session start. */
export function endSilentEgress(session: SilentEgressSession | undefined): void {
  if (!session) return
  restoreProxyEnv(session.originalProxyEnv)
  if (session.config) {
    saveEgressRotationState(session.statePath, session.state)
  }
  invalidateRedscopeStatusCache()
}

/**
 * Run an async test body with silent egress armed. Always restores env.
 */
export async function withSilentEgress<T>(
  body: (session: SilentEgressSession) => Promise<T>,
  options: EnsureSilentEgressOptions = {},
): Promise<T> {
  const session = await ensureWorkingSilentEgress(options)
  try {
    return await body(session)
  } finally {
    endSilentEgress(session)
  }
}
