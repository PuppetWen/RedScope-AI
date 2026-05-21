import { access, mkdir, writeFile } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearProxyCache, getProxyFetchOptions } from '../src/utils/proxy.ts'
import { getExistingRefereeEgressConfigFilePath } from '../src/utils/authorizedEgressConfig.ts'
import {
  type EgressConfig,
  type EgressNode,
  type EgressState,
  loadEgressConfig,
  proxyEnvForNode,
  readEgressState,
  recordBlockedEgressNode,
  recordUsedEgressNode,
  selectHealthyEgressNode,
  selectNextEgressNode,
  validateEgressConfig,
  writeEgressState,
} from './redscope-egress-policy.ts'

type EgressEvent = {
  at: string
  type:
    | 'selected'
    | 'disabled'
    | 'invalid-config'
    | 'block-detected'
    | 'connectivity-check-failed'
    | 'used-recorded'
    | 'switched'
    | 'switch-unavailable'
  nodeId?: string
  fromNodeId?: string
  toNodeId?: string
  statusCode?: number
  reason?: string
  message: string
}

export type AuthorizedEgressSession = {
  enabled: boolean
  automatic: boolean
  configPath?: string
  statePath?: string
  poolId?: string
  target?: string
  currentNode?: EgressNode
  switchCount: number
  maxSwitches: number
  switchOnHttpStatuses: number[]
  validateBeforeUse: boolean
  connectivityCheckTimeoutMs: number
  avoidUsedForTarget: boolean
  originalProxyEnv: Record<string, string | undefined>
  events: EgressEvent[]
}

type FetchRetryOptions = {
  retryOnBlockStatus?: boolean
  retryOnNetworkError?: boolean
  reason?: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultRefereeConfigPath = 'tools/authorized-egress.referee-provided.json'
const defaultStatePath = 'tools/manifests/redscope-egress-state.json'
const defaultConnectivityCheckTimeoutMs = 3000
const proxyEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const
const defaultBlockStatuses = [403, 407, 429, 451]

function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)
}

function projectPath(path: string): string {
  const relativePath = relative(repoRoot, path).split(sep).join('/')
  return relativePath || '.'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(resolveProjectPath(path))
    return true
  } catch {
    return false
  }
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function envFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function pushEvent(
  session: AuthorizedEgressSession,
  event: Omit<EgressEvent, 'at'>,
): void {
  session.events.push(egressEvent(event))
}

function egressEvent(event: Omit<EgressEvent, 'at'>): EgressEvent {
  return { at: new Date().toISOString(), ...event }
}

function originalProxyEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of proxyEnvKeys) env[key] = process.env[key]
  return env
}

function restoreOriginalProxyEnv(session: AuthorizedEgressSession): void {
  for (const key of proxyEnvKeys) {
    const value = session.originalProxyEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearProxyCache()
}

function applyProxyEnv(session: AuthorizedEgressSession): void {
  if (!session.enabled || !session.currentNode) return
  for (const key of proxyEnvKeys) delete process.env[key]
  Object.assign(process.env, proxyEnvForNode(session.currentNode))
  clearProxyCache()
}

function normalizeStatuses(value: unknown): number[] {
  if (!Array.isArray(value)) return defaultBlockStatuses
  const statuses = value.filter(
    (item): item is number =>
      Number.isInteger(item) && item >= 100 && item <= 599,
  )
  return statuses.length > 0 ? statuses : defaultBlockStatuses
}

function selectedConfigPath(): string | undefined {
  return envValue(
    'REDSCOPE_TOOLS_AUTO_EGRESS_CONFIG',
    'REDSCOPE_AUTO_EGRESS_CONFIG',
    'REDSCOPE_TOOLS_EGRESS_CONFIG',
    'REDSCOPE_EGRESS_CONFIG',
  )
}

async function defaultConfigPath(): Promise<string | undefined> {
  const explicit = selectedConfigPath()
  if (explicit) return explicit
  const userConfig = getExistingRefereeEgressConfigFilePath()
  if (userConfig) return userConfig
  if (await pathExists(defaultRefereeConfigPath)) return defaultRefereeConfigPath
  return undefined
}

function shouldAutoUse(config: EgressConfig): boolean {
  const explicit = envFlag(
    envValue('REDSCOPE_AUTO_EGRESS', 'REDSCOPE_EGRESS_AUTO'),
  )
  if (explicit !== undefined) return explicit
  return config.policy?.autoUseForAuthorizedTesting === true
}

function shouldValidateBeforeUse(config: EgressConfig): boolean {
  const explicit = envFlag(
    envValue(
      'REDSCOPE_EGRESS_VALIDATE_CONNECTIVITY',
      'REDSCOPE_AUTO_EGRESS_VALIDATE_CONNECTIVITY',
    ),
  )
  if (explicit !== undefined) return explicit
  return config.policy?.validateBeforeUse !== false
}

function shouldAvoidUsedForTarget(config: EgressConfig): boolean {
  const explicit = envFlag(
    envValue(
      'REDSCOPE_EGRESS_AVOID_USED_PER_TARGET',
      'REDSCOPE_AUTO_EGRESS_AVOID_USED_PER_TARGET',
    ),
  )
  if (explicit !== undefined) return explicit
  return config.policy?.avoidPreviouslyUsedNodesPerTarget !== false
}

function connectivityCheckTimeoutMs(config: EgressConfig): number {
  return (
    positiveInteger(envValue('REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS')) ??
    config.policy?.connectivityCheckTimeoutMs ??
    defaultConnectivityCheckTimeoutMs
  )
}

function sessionDisabled(message: string): AuthorizedEgressSession {
  const session: AuthorizedEgressSession = {
    enabled: false,
    automatic: false,
    switchCount: 0,
    maxSwitches: 0,
    switchOnHttpStatuses: defaultBlockStatuses,
    validateBeforeUse: false,
    connectivityCheckTimeoutMs: defaultConnectivityCheckTimeoutMs,
    avoidUsedForTarget: false,
    originalProxyEnv: originalProxyEnv(),
    events: [],
  }
  pushEvent(session, {
    type: 'disabled',
    message,
  })
  return session
}

export function isTargetSideEgressBlockStatus(
  statusCode: number,
  statuses = defaultBlockStatuses,
): boolean {
  return statuses.includes(statusCode)
}

async function selectUsableEgressNode(
  config: EgressConfig,
  state: EgressState,
  options: {
    statePath: string
    poolId: string
    currentNodeId?: string
    target?: string
    now: Date
    validateBeforeUse: boolean
    connectivityCheckTimeoutMs: number
    avoidUsedForTarget: boolean
  },
): Promise<{
  node?: EgressNode
  state: EgressState
  events: EgressEvent[]
  message: string
}> {
  const events: EgressEvent[] = []
  let updatedState = state

  if (!options.validateBeforeUse) {
    const plan = selectNextEgressNode(config, state, {
      poolId: options.poolId,
      currentNodeId: options.currentNodeId,
      target: options.target,
      now: options.now,
      avoidUsedForTarget: options.avoidUsedForTarget,
    })
    if (plan.nextNode) {
      updatedState = recordUsedEgressNode(updatedState, {
        poolId: options.poolId,
        node: plan.nextNode,
        target: options.target,
        now: options.now,
      })
      await writeEgressState(options.statePath, updatedState)
      events.push(
        egressEvent({
          type: 'used-recorded',
          nodeId: plan.nextNode.id,
          message: `Recorded approved egress node ${plan.nextNode.id} as used for this target.`,
        }),
      )
    }
    return {
      node: plan.nextNode,
      state: updatedState,
      events,
      message: plan.message,
    }
  }

  const health = await selectHealthyEgressNode(config, state, {
    poolId: options.poolId,
    currentNodeId: options.currentNodeId,
    target: options.target,
    timeoutMs: options.connectivityCheckTimeoutMs,
    now: options.now,
    avoidUsedForTarget: options.avoidUsedForTarget,
  })

  for (const checked of health.nodes) {
    if (checked.reachable || checked.skippedReason) continue
    if (!checked.nodeId || checked.nodeId === '<missing-id>') continue
    updatedState = recordBlockedEgressNode(updatedState, {
      poolId: options.poolId,
      nodeId: checked.nodeId,
      target: options.target,
      reason: `connectivity check failed: ${checked.error ?? 'unknown error'}`,
      blockedCooldownHours: config.policy?.blockedCooldownHours ?? 24,
      now: options.now,
    })
    events.push(
      egressEvent({
        type: 'connectivity-check-failed',
        nodeId: checked.nodeId,
        reason: checked.error,
        message: `Connectivity check failed for approved egress node ${checked.nodeId}.`,
      }),
    )
  }

  if (health.selectedNode) {
    updatedState = recordUsedEgressNode(updatedState, {
      poolId: options.poolId,
      node: health.selectedNode,
      target: options.target,
      now: options.now,
    })
    events.push(
      egressEvent({
        type: 'used-recorded',
        nodeId: health.selectedNode.id,
        message: `Recorded approved egress node ${health.selectedNode.id} as used for this target.`,
      }),
    )
  }

  if (updatedState !== state || health.selectedNode) {
    await writeEgressState(options.statePath, updatedState)
  }

  return {
    node: health.selectedNode,
    state: updatedState,
    events,
    message: health.message,
  }
}

export async function createAuthorizedEgressSession(
  target: string | undefined,
): Promise<AuthorizedEgressSession> {
  const configPath = await defaultConfigPath()
  if (!configPath) {
    return sessionDisabled('No authorized egress config was found.')
  }

  const resolvedConfigPath = resolveProjectPath(configPath)
  const config = await loadEgressConfig(configPath)
  if (!shouldAutoUse(config)) {
    return sessionDisabled(
      'Authorized egress config did not opt in to automatic use.',
    )
  }

  const poolId =
    envValue('REDSCOPE_TOOLS_EGRESS_POOL', 'REDSCOPE_EGRESS_POOL') ??
    config.policy?.defaultPoolId ??
    config.egressPools?.[0]?.id
  if (!poolId) {
    throw new Error('automatic egress could not find an egress pool id')
  }

  const validation = validateEgressConfig(config, {
    configPath: resolvedConfigPath,
    poolId,
    target,
  })
  if (!validation.canUse) {
    const detail = validation.issues
      .map(issue => `${issue.path}: ${issue.message}`)
      .join('; ')
    throw new Error(`automatic egress config is not usable: ${detail}`)
  }

  const statePath =
    envValue('REDSCOPE_TOOLS_EGRESS_STATE', 'REDSCOPE_EGRESS_STATE') ??
    config.policy?.statePath ??
    defaultStatePath
  const state = await readEgressState(statePath)
  const validateBeforeUse = shouldValidateBeforeUse(config)
  const avoidUsedForTarget = shouldAvoidUsedForTarget(config)
  const timeoutMs = connectivityCheckTimeoutMs(config)
  const selected = await selectUsableEgressNode(config, state, {
    statePath,
    poolId,
    target,
    now: new Date(),
    validateBeforeUse,
    connectivityCheckTimeoutMs: timeoutMs,
    avoidUsedForTarget,
  })
  if (!selected.node) {
    throw new Error(selected.message)
  }

  const session: AuthorizedEgressSession = {
    enabled: true,
    automatic: true,
    configPath: projectPath(resolvedConfigPath),
    statePath,
    poolId,
    target,
    currentNode: selected.node,
    switchCount: 0,
    maxSwitches:
      positiveInteger(envValue('REDSCOPE_EGRESS_MAX_SWITCHES')) ??
      config.policy?.maxAutoSwitchesPerStep ??
      8,
    switchOnHttpStatuses: normalizeStatuses(
      config.policy?.switchOnHttpStatuses,
    ),
    validateBeforeUse,
    connectivityCheckTimeoutMs: timeoutMs,
    avoidUsedForTarget,
    originalProxyEnv: originalProxyEnv(),
    events: [...selected.events],
  }
  applyProxyEnv(session)
  pushEvent(session, {
    type: 'selected',
    nodeId: selected.node.id,
    message: validateBeforeUse
      ? `Selected reachable approved egress node ${selected.node.id}.`
      : `Selected approved egress node ${selected.node.id}.`,
  })
  return session
}

export function authorizedEgressEnv(
  session: AuthorizedEgressSession | undefined,
): Record<string, string> {
  if (!session?.enabled || !session.currentNode) return {}
  return proxyEnvForNode(session.currentNode)
}

export async function recordBlockAndSwitchAuthorizedEgress(
  session: AuthorizedEgressSession | undefined,
  signal: {
    statusCode?: number
    reason: string
  },
): Promise<boolean> {
  if (
    !session?.enabled ||
    !session.poolId ||
    !session.currentNode?.id ||
    !session.statePath
  ) {
    return false
  }
  if (session.switchCount >= session.maxSwitches) {
    pushEvent(session, {
      type: 'switch-unavailable',
      nodeId: session.currentNode.id,
      statusCode: signal.statusCode,
      reason: signal.reason,
      message: 'Automatic egress switch limit was reached for this step.',
    })
    return false
  }

  const configPath = selectedConfigPath() ?? session.configPath ?? defaultRefereeConfigPath
  const config = await loadEgressConfig(configPath)
  const state = await readEgressState(session.statePath)
  const now = new Date()
  const updatedState = recordBlockedEgressNode(state, {
    poolId: session.poolId,
    nodeId: session.currentNode.id,
    target: session.target,
    statusCode: signal.statusCode,
    reason: signal.reason,
    blockedCooldownHours: config.policy?.blockedCooldownHours ?? 24,
    now,
  })
  await writeEgressState(session.statePath, updatedState)

  pushEvent(session, {
    type: 'block-detected',
    nodeId: session.currentNode.id,
    statusCode: signal.statusCode,
    reason: signal.reason,
    message: `Recorded target-side egress block signal for ${session.currentNode.id}.`,
  })

  const selected = await selectUsableEgressNode(config, updatedState, {
    statePath: session.statePath,
    poolId: session.poolId,
    currentNodeId: session.currentNode.id,
    target: session.target,
    now,
    validateBeforeUse: session.validateBeforeUse,
    connectivityCheckTimeoutMs: session.connectivityCheckTimeoutMs,
    avoidUsedForTarget: session.avoidUsedForTarget,
  })
  session.events.push(...selected.events)
  if (!selected.node) {
    pushEvent(session, {
      type: 'switch-unavailable',
      fromNodeId: session.currentNode.id,
      statusCode: signal.statusCode,
      reason: signal.reason,
      message: selected.message,
    })
    return false
  }

  const previousNodeId = session.currentNode.id
  session.currentNode = selected.node
  session.switchCount++
  applyProxyEnv(session)
  pushEvent(session, {
    type: 'switched',
    fromNodeId: previousNodeId,
    toNodeId: selected.node.id,
    statusCode: signal.statusCode,
    reason: signal.reason,
    message: session.validateBeforeUse
      ? `Automatically switched to reachable approved egress node ${selected.node.id}.`
      : `Automatically switched to approved egress node ${selected.node.id}.`,
  })
  return true
}

export async function fetchWithAuthorizedEgress(
  session: AuthorizedEgressSession | undefined,
  input: string | URL | Request,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  for (;;) {
    const fetchInit = session?.enabled
      ? ({ ...init, ...getProxyFetchOptions() } as RequestInit)
      : init

    try {
      const response = await fetch(input, fetchInit)
      if (
        session?.enabled &&
        options.retryOnBlockStatus !== false &&
        isTargetSideEgressBlockStatus(
          response.status,
          session.switchOnHttpStatuses,
        )
      ) {
        if (response.body) {
          await response.body.cancel().catch(() => undefined)
        }
        const switched = await recordBlockAndSwitchAuthorizedEgress(session, {
          statusCode: response.status,
          reason: options.reason ?? 'target-side HTTP block signal',
        })
        if (switched) continue
      }
      return response
    } catch (error) {
      if (!session?.enabled || options.retryOnNetworkError === false) throw error
      const switched = await recordBlockAndSwitchAuthorizedEgress(session, {
        reason: `network error: ${error instanceof Error ? error.message : String(error)}`,
      })
      if (!switched) throw error
    }
  }
}

export async function writeAuthorizedEgressManifest(
  runDir: string,
  session: AuthorizedEgressSession | undefined,
): Promise<void> {
  if (!session) return
  const manifestPath = join(runDir, 'egress-manifest.json')
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        enabled: session.enabled,
        automatic: session.automatic,
        configPath: session.configPath,
        statePath: session.statePath,
        poolId: session.poolId,
        target: session.target,
        currentNodeId: session.currentNode?.id,
        switchCount: session.switchCount,
        maxSwitches: session.maxSwitches,
        switchOnHttpStatuses: session.switchOnHttpStatuses,
        validateBeforeUse: session.validateBeforeUse,
        connectivityCheckTimeoutMs: session.connectivityCheckTimeoutMs,
        avoidUsedForTarget: session.avoidUsedForTarget,
        events: session.events,
        notes: [
          'Automatic egress applies only to the authorized egress config selected for this run.',
          'RedScope records block signals and rotates only within that approved pool.',
          'Reachability checks and per-target used-node tracking prevent reusing a source IP already used against the same target.',
        ],
      },
      null,
      2,
    )}\n`,
  )
}

export function restoreAuthorizedEgressEnv(
  session: AuthorizedEgressSession | undefined,
): void {
  if (!session?.enabled) return
  restoreOriginalProxyEnv(session)
}
