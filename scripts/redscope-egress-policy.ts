#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import net from 'node:net'
import { envPathFrom } from './redscope-env-config.ts'
import { getExistingRefereeEgressConfigFilePath } from '../src/utils/authorizedEgressConfig.ts'

export type Authorization = {
  authorizedBy?: string
  reference?: string
  validFrom?: string
  validTo?: string
  emergencyContact?: string
}

export type RateLimits = {
  requestsPerSecond?: number
  concurrency?: number
}

export type TargetSet = {
  any?: boolean
  domains?: string[]
  urls?: string[]
  ips?: string[]
  cidrs?: string[]
}

export type EgressNode = {
  id?: string
  name?: string
  kind?: string
  endpoint?: string
  sourceIp?: string
  provider?: string
  region?: string
  authEnv?: string
  ownershipEvidence?: string
  approvedBy?: string
  approvalReference?: string
  enabled?: boolean
  notes?: string[]
}

export type EgressPool = {
  id?: string
  name?: string
  owner?: string
  authorization?: Authorization
  allowedTargets?: TargetSet
  rateLimits?: RateLimits
  nodes?: EgressNode[]
  restrictions?: {
    disallowPublicFreeProxies?: boolean
    disallowUnverifiedNodes?: boolean
  }
  notes?: string[]
}

export type EgressConfig = {
  schemaVersion?: number
  generatedAt?: string
  policy?: {
    requireAuthorization?: boolean
    disallowPublicFreeProxies?: boolean
    disallowUnverifiedNodes?: boolean
    autoUseForAuthorizedTesting?: boolean
    defaultPoolId?: string
    maxAutoSwitchesPerStep?: number
    switchOnHttpStatuses?: number[]
    validateBeforeUse?: boolean
    connectivityCheckTimeoutMs?: number
    avoidPreviouslyUsedNodesPerTarget?: boolean
    defaultRefreshIntervalDays?: number
    blockedCooldownHours?: number
    statePath?: string
    notes?: string[]
  }
  egressPools?: EgressPool[]
}

type ValidationSeverity = 'error' | 'warning'

type ValidationIssue = {
  severity: ValidationSeverity
  path: string
  message: string
}

type PoolSummary = {
  id: string
  name?: string
  owner?: string
  nodeCount: number
  enabledNodeCount: number
  allowedTargetCount: number
  status: 'ok' | 'error'
  issues: ValidationIssue[]
}

export type EgressValidationResult = {
  status: 'ok' | 'error'
  canUse: boolean
  generatedAt: string
  configPath?: string
  pools: PoolSummary[]
  issues: ValidationIssue[]
}

type Options = {
  command: 'check' | 'list' | 'blocked' | 'next' | 'health'
  configPath: string
  statePath: string
  statePathFromCli: boolean
  poolId?: string
  nodeId?: string
  target?: string
  statusCode?: number
  reason?: string
  timeoutMs: number
  emitEnv: boolean
  json: boolean
  strict: boolean
}

type BlockedNodeRecord = {
  poolId: string
  nodeId: string
  target?: string
  statusCode?: number
  reason?: string
  blockedAt: string
  blockedUntil: string
}

type UsedNodeRecord = {
  poolId: string
  nodeId: string
  target?: string
  sourceIp?: string
  endpointHost?: string
  firstUsedAt: string
  lastUsedAt: string
  useCount: number
}

export type EgressState = {
  schemaVersion: 1
  updatedAt: string
  blockedNodes: BlockedNodeRecord[]
  usedNodes?: UsedNodeRecord[]
}

export type EgressSwitchPlan = {
  poolId: string
  currentNodeId?: string
  target?: string
  nextNode?: EgressNode
  message: string
}

type EgressNodeConnectivity = {
  reachable: boolean
  latencyMs?: number
  error?: string
}

type EgressHealthNode = EgressNodeConnectivity & {
  poolId: string
  nodeId: string
  endpoint?: string
  skippedReason?: string
}

export type EgressHealthResult = {
  poolId: string
  target?: string
  selectedNode?: EgressNode
  nodes: EgressHealthNode[]
  message: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultConfigPath = envPathFrom(
  ['REDSCOPE_TOOLS_EGRESS_CONFIG', 'REDSCOPE_EGRESS_CONFIG'],
  getExistingRefereeEgressConfigFilePath() ??
    'tools/authorized-egress.example.json',
)
const defaultStatePath = envPathFrom(
  ['REDSCOPE_TOOLS_EGRESS_STATE', 'REDSCOPE_EGRESS_STATE'],
  'tools/manifests/redscope-egress-state.json',
)

const allowedNodeKinds = new Set([
  'owned-vpn',
  'corporate-egress',
  'cloud-egress',
  'customer-approved-proxy',
  'lab-vpn',
  'private-relay',
  'dedicated-vps',
  'referee-approved-proxy',
])

const blockedNodeKinds = new Set([
  'public-free-proxy',
  'scraped-proxy',
  'free-proxy-list',
  'tor-exit',
  'unknown',
])

const publicProxySourcePatterns = [
  'zdaye.com',
  'free-proxy',
  'free proxy',
  'public-proxy',
  'public proxy',
  'scraped proxy',
  'proxy list',
]

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-egress-policy.ts --check [options]
  bun run scripts/redscope-egress-policy.ts --list [options]
  bun run scripts/redscope-egress-policy.ts --blocked --pool <id> --node <id> [options]
  bun run scripts/redscope-egress-policy.ts --next --pool <id> [options]
  bun run scripts/redscope-egress-policy.ts --health --pool <id> [options]

Commands:
  --check                 Validate authorized egress configuration
  --list                  List configured egress pools and nodes
  --blocked               Record a target-side block signal for a node
  --next                  Select the next approved node in a pool
  --health                Select the first reachable approved node in a pool

Options:
  --config <path>         Egress config path (default: ${defaultConfigPath})
  --state <path>          Egress state path (default: ${defaultStatePath})
  --pool <id>             Limit checks/list output to a pool id
  --node <id>             Select a node, required with --emit-env
  --target <value>        Check that the pool authorizes a URL/domain/IP
  --status <code>         HTTP status observed for a block signal
  --reason <text>         Human-readable block reason
  --timeout-ms <ms>       TCP health-check timeout per node (default: 3000)
  --emit-env              Emit HTTP_PROXY/HTTPS_PROXY/ALL_PROXY for a node
  --strict                Exit non-zero when validation finds errors
  --json                  Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'check',
    configPath: defaultConfigPath,
    statePath: defaultStatePath,
    statePathFromCli: false,
    timeoutMs: 3000,
    emitEnv: false,
    json: false,
    strict: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--check') {
      options.command = 'check'
      continue
    }
    if (arg === '--list') {
      options.command = 'list'
      continue
    }
    if (arg === '--blocked') {
      options.command = 'blocked'
      continue
    }
    if (arg === '--next') {
      options.command = 'next'
      continue
    }
    if (arg === '--health') {
      options.command = 'health'
      continue
    }
    if (arg === '--emit-env') {
      options.emitEnv = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--strict') {
      options.strict = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--config':
        options.configPath = next
        break
      case '--state':
        options.statePath = next
        options.statePathFromCli = true
        break
      case '--pool':
        options.poolId = next
        break
      case '--node':
        options.nodeId = next
        break
      case '--target':
        options.target = next
        break
      case '--status': {
        const statusCode = Number(next)
        if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
          console.error('--status must be an HTTP status code')
          process.exit(2)
        }
        options.statusCode = statusCode
        break
      }
      case '--reason':
        options.reason = next
        break
      case '--timeout-ms': {
        const timeoutMs = Number(next)
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          console.error('--timeout-ms must be a positive integer')
          process.exit(2)
        }
        options.timeoutMs = timeoutMs
        break
      }
      default:
        usage()
    }
    index++
  }

  if (
    options.emitEnv &&
    options.command !== 'next' &&
    options.command !== 'health' &&
    (!options.poolId || !options.nodeId)
  ) {
    console.error('--emit-env requires both --pool and --node')
    process.exit(2)
  }
  if (options.command === 'blocked' && (!options.poolId || !options.nodeId)) {
    console.error('--blocked requires both --pool and --node')
    process.exit(2)
  }
  if (options.command === 'next' && !options.poolId) {
    console.error('--next requires --pool')
    process.exit(2)
  }
  if (options.command === 'health' && !options.poolId) {
    console.error('--health requires --pool')
    process.exit(2)
  }

  return options
}

function resolveFromRepo(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addIssue(
  issues: ValidationIssue[],
  severity: ValidationSeverity,
  path: string,
  message: string,
): void {
  issues.push({ severity, path, message })
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function countTargets(targets: TargetSet | undefined): number {
  if (!targets) return 0
  const explicitTargets = [
    targets.domains,
    targets.urls,
    targets.ips,
    targets.cidrs,
  ].reduce((count, values) => count + (values?.length ?? 0), 0)
  return explicitTargets + (targets.any ? 1 : 0)
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function validateAuthorization(
  authorization: Authorization | undefined,
  path: string,
  now: Date,
  issues: ValidationIssue[],
): void {
  if (!authorization) {
    addIssue(issues, 'error', path, 'authorization is required')
    return
  }

  for (const field of [
    'authorizedBy',
    'reference',
    'validFrom',
    'validTo',
    'emergencyContact',
  ] as const) {
    if (!hasText(authorization[field])) {
      addIssue(issues, 'error', `${path}.${field}`, `${field} is required`)
    }
  }

  const validFrom = parseDate(authorization.validFrom)
  const validTo = parseDate(authorization.validTo)

  if (authorization.validFrom && !validFrom) {
    addIssue(issues, 'error', `${path}.validFrom`, 'validFrom is invalid')
  }
  if (authorization.validTo && !validTo) {
    addIssue(issues, 'error', `${path}.validTo`, 'validTo is invalid')
  }
  if (validFrom && validTo && validFrom.getTime() > validTo.getTime()) {
    addIssue(
      issues,
      'error',
      path,
      'authorization validFrom must be before validTo',
    )
  }

  if (validFrom && now.getTime() < validFrom.getTime()) {
    addIssue(issues, 'error', path, 'authorization window has not started')
  }
  if (validTo) {
    const validToEnd = new Date(validTo)
    validToEnd.setUTCHours(23, 59, 59, 999)
    if (now.getTime() > validToEnd.getTime()) {
      addIssue(issues, 'error', path, 'authorization window has expired')
    }
  }
}

function validateRateLimits(
  rateLimits: RateLimits | undefined,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!rateLimits) {
    addIssue(issues, 'error', path, 'rateLimits are required')
    return
  }

  if (
    typeof rateLimits.requestsPerSecond !== 'number' ||
    !Number.isFinite(rateLimits.requestsPerSecond) ||
    rateLimits.requestsPerSecond <= 0
  ) {
    addIssue(
      issues,
      'error',
      `${path}.requestsPerSecond`,
      'requestsPerSecond must be a positive number',
    )
  }

  if (
    typeof rateLimits.concurrency !== 'number' ||
    !Number.isFinite(rateLimits.concurrency) ||
    rateLimits.concurrency <= 0
  ) {
    addIssue(
      issues,
      'error',
      `${path}.concurrency`,
      'concurrency must be a positive number',
    )
  }
}

function validateConfigFreshness(
  config: EgressConfig,
  now: Date,
  issues: ValidationIssue[],
): void {
  const intervalDays = config.policy?.defaultRefreshIntervalDays ?? 1
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    addIssue(
      issues,
      'error',
      'policy.defaultRefreshIntervalDays',
      'defaultRefreshIntervalDays must be a positive number',
    )
    return
  }

  if (!hasText(config.generatedAt)) {
    addIssue(
      issues,
      'warning',
      'generatedAt',
      'generatedAt is recommended so egress review freshness can be checked',
    )
    return
  }

  const generatedAt = new Date(config.generatedAt)
  if (Number.isNaN(generatedAt.getTime())) {
    addIssue(issues, 'error', 'generatedAt', 'generatedAt is invalid')
    return
  }

  const ageMs = now.getTime() - generatedAt.getTime()
  const maxAgeMs = intervalDays * 24 * 60 * 60 * 1000
  if (ageMs > maxAgeMs) {
    addIssue(
      issues,
      'warning',
      'generatedAt',
      `egress config is older than ${intervalDays} day(s); review approved nodes before use`,
    )
  }
}

function rawEndpointCredentials(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return hasText(url.username) || hasText(url.password)
  } catch {
    return false
  }
}

function validateEndpoint(
  endpoint: string | undefined,
  path: string,
  issues: ValidationIssue[],
): URL | undefined {
  if (!hasText(endpoint)) {
    addIssue(issues, 'error', path, 'endpoint is required')
    return undefined
  }

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    addIssue(issues, 'error', path, 'endpoint must be a valid URL')
    return undefined
  }

  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    addIssue(
      issues,
      'error',
      path,
      'endpoint protocol must be http, https, socks4, or socks5',
    )
  }
  if (!hasText(parsed.hostname)) {
    addIssue(issues, 'error', path, 'endpoint host is required')
  }
  if (rawEndpointCredentials(endpoint)) {
    addIssue(
      issues,
      'error',
      path,
      'do not put proxy credentials in endpoint URLs; use authEnv instead',
    )
  }

  return parsed
}

function publicProxySignals(node: EgressNode): string[] {
  const record = node as Record<string, unknown>
  const values: string[] = []

  for (const key of ['kind', 'source', 'sourceUrl', 'sourceType', 'collector']) {
    const value = record[key]
    if (typeof value === 'string') values.push(value.toLowerCase())
  }

  return publicProxySourcePatterns.filter(pattern =>
    values.some(value => value.includes(pattern)),
  )
}

function validateNode(
  node: EgressNode,
  path: string,
  disallowUnverifiedNodes: boolean,
  issues: ValidationIssue[],
): void {
  if (!hasText(node.id)) {
    addIssue(issues, 'error', `${path}.id`, 'node id is required')
  }

  if (!hasText(node.kind)) {
    addIssue(issues, 'error', `${path}.kind`, 'node kind is required')
  } else if (blockedNodeKinds.has(node.kind.trim())) {
    addIssue(
      issues,
      'error',
      `${path}.kind`,
      `node kind ${node.kind} is not allowed for RedScope egress`,
    )
  } else if (!allowedNodeKinds.has(node.kind.trim())) {
    addIssue(
      issues,
      'error',
      `${path}.kind`,
      `node kind ${node.kind} is not an approved authorized-egress kind`,
    )
  }

  validateEndpoint(node.endpoint, `${path}.endpoint`, issues)

  const publicSignals = publicProxySignals(node)
  if (publicSignals.length > 0) {
    addIssue(
      issues,
      'error',
      path,
      `public/free proxy source signals are not allowed: ${publicSignals.join(
        ', ',
      )}`,
    )
  }

  if (disallowUnverifiedNodes && !hasText(node.ownershipEvidence)) {
    addIssue(
      issues,
      'error',
      `${path}.ownershipEvidence`,
      'ownershipEvidence is required for authorized egress nodes',
    )
  }

  if (hasText(node.authEnv) && !/^REDSCOPE_[A-Z0-9_]+$/.test(node.authEnv)) {
    addIssue(
      issues,
      'warning',
      `${path}.authEnv`,
      'authEnv should use a REDSCOPE_* environment variable name',
    )
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = normalizeDomain(host)
  const normalizedDomain = normalizeDomain(domain)
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  )
}

function ipv4ToNumber(value: string): number | undefined {
  if (net.isIP(value) !== 4) return undefined
  const parts = value.split('.').map(part => Number(part))
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined
  }
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  )
}

function ipv4MatchesCidr(ip: string, cidr: string): boolean {
  const [range, prefixText] = cidr.split('/')
  const prefix = Number(prefixText)
  const ipNumber = ipv4ToNumber(ip)
  const rangeNumber = ipv4ToNumber(range)
  if (
    ipNumber === undefined ||
    rangeNumber === undefined ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipNumber & mask) === (rangeNumber & mask)
}

export function targetAllowedByPool(target: string, pool: EgressPool): boolean {
  const allowed = pool.allowedTargets
  if (!allowed) return false
  if (allowed.any === true) return true

  let hostOrIp = target.trim()
  let urlString: string | undefined

  try {
    const url = new URL(target)
    hostOrIp = url.hostname
    urlString = url.toString()
  } catch {
    // Plain domain or IP input is valid for this check.
  }

  if (
    urlString &&
    (allowed.urls ?? []).some(url => url.trim() === urlString)
  ) {
    return true
  }

  if (
    net.isIP(hostOrIp) === 0 &&
    (allowed.domains ?? []).some(domain => hostMatchesDomain(hostOrIp, domain))
  ) {
    return true
  }

  if (net.isIP(hostOrIp) !== 0) {
    if ((allowed.ips ?? []).includes(hostOrIp)) return true
    return (allowed.cidrs ?? []).some(cidr => ipv4MatchesCidr(hostOrIp, cidr))
  }

  return false
}

function normalizeStateTarget(target: string | undefined): string | undefined {
  if (!target) return undefined
  try {
    const url = new URL(target)
    url.hash = ''
    return url.toString().toLowerCase()
  } catch {
    return target.trim().toLowerCase()
  }
}

function endpointHost(node: EgressNode): string | undefined {
  if (!node.endpoint) return undefined
  try {
    return new URL(node.endpoint).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function normalizeNodeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized || undefined
}

function nodeAddress(node: EgressNode): {
  sourceIp?: string
  endpointHost?: string
} {
  return {
    sourceIp: normalizeNodeAddress(node.sourceIp),
    endpointHost: normalizeNodeAddress(endpointHost(node)),
  }
}

function usedRecordMatchesTarget(
  record: UsedNodeRecord,
  target: string | undefined,
): boolean {
  const normalizedRecordTarget = normalizeStateTarget(record.target)
  const normalizedTarget = normalizeStateTarget(target)
  return (
    !normalizedRecordTarget ||
    !normalizedTarget ||
    normalizedRecordTarget === normalizedTarget
  )
}

function usedRecordMatchesNode(
  record: UsedNodeRecord,
  node: EgressNode,
): boolean {
  if (node.id && record.nodeId === node.id) return true
  const address = nodeAddress(node)
  if (record.sourceIp || address.sourceIp) {
    return Boolean(address.sourceIp && record.sourceIp === address.sourceIp)
  }
  return Boolean(
    address.endpointHost && record.endpointHost === address.endpointHost,
  )
}

function nodeWasUsedForTarget(
  state: EgressState,
  poolId: string,
  node: EgressNode,
  target: string | undefined,
): boolean {
  return (state.usedNodes ?? []).some(
    record =>
      record.poolId === poolId &&
      usedRecordMatchesTarget(record, target) &&
      usedRecordMatchesNode(record, node),
  )
}

export async function readEgressState(statePath: string): Promise<EgressState> {
  try {
    const text = await readFile(resolveFromRepo(statePath), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (
      isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.blockedNodes)
    ) {
      return {
        schemaVersion: 1,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
        blockedNodes: parsed.blockedNodes as BlockedNodeRecord[],
        usedNodes: Array.isArray(parsed.usedNodes)
          ? (parsed.usedNodes as UsedNodeRecord[])
          : [],
      }
    }
  } catch {
    // Missing or malformed state should not make authorized egress unusable.
  }

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    blockedNodes: [],
    usedNodes: [],
  }
}

export async function writeEgressState(
  statePath: string,
  state: EgressState,
): Promise<void> {
  const resolved = resolveFromRepo(statePath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(state, null, 2)}\n`)
}

function blockedRecordIsActive(
  record: BlockedNodeRecord,
  now: Date,
  target: string | undefined,
): boolean {
  if (new Date(record.blockedUntil).getTime() <= now.getTime()) return false
  const normalizedRecordTarget = normalizeStateTarget(record.target)
  const normalizedTarget = normalizeStateTarget(target)
  return (
    !normalizedRecordTarget ||
    !normalizedTarget ||
    normalizedRecordTarget === normalizedTarget
  )
}

function nodeIsBlocked(
  state: EgressState,
  poolId: string,
  nodeId: string,
  target: string | undefined,
  now: Date,
): boolean {
  return state.blockedNodes.some(
    record =>
      record.poolId === poolId &&
      record.nodeId === nodeId &&
      blockedRecordIsActive(record, now, target),
  )
}

function activeBlockedRecords(
  state: EgressState,
  now: Date,
): BlockedNodeRecord[] {
  return state.blockedNodes.filter(record =>
    blockedRecordIsActive(record, now, record.target),
  )
}

export function recordBlockedEgressNode(
  state: EgressState,
  options: {
    poolId: string
    nodeId: string
    target?: string
    statusCode?: number
    reason?: string
    blockedCooldownHours: number
    now: Date
  },
): EgressState {
  const blockedAt = options.now.toISOString()
  const blockedUntil = new Date(
    options.now.getTime() + options.blockedCooldownHours * 60 * 60 * 1000,
  ).toISOString()
  const existing = activeBlockedRecords(state, options.now).filter(
    record =>
      !(
        record.poolId === options.poolId &&
        record.nodeId === options.nodeId &&
        normalizeStateTarget(record.target) === normalizeStateTarget(options.target)
      ),
  )

  return {
    schemaVersion: 1,
    updatedAt: blockedAt,
    blockedNodes: [
      ...existing,
      {
        poolId: options.poolId,
        nodeId: options.nodeId,
        target: options.target,
        statusCode: options.statusCode,
        reason: options.reason,
        blockedAt,
        blockedUntil,
      },
    ],
    usedNodes: state.usedNodes ?? [],
  }
}

export function recordUsedEgressNode(
  state: EgressState,
  options: {
    poolId: string
    node: EgressNode
    target?: string
    now: Date
  },
): EgressState {
  if (!options.node.id) return state
  const usedAt = options.now.toISOString()
  const address = nodeAddress(options.node)
  const existing = state.usedNodes ?? []
  const current = existing.find(
    record =>
      record.poolId === options.poolId &&
      usedRecordMatchesTarget(record, options.target) &&
      usedRecordMatchesNode(record, options.node),
  )
  const nextRecord: UsedNodeRecord = current
    ? {
        ...current,
        nodeId: options.node.id,
        target: options.target,
        sourceIp: address.sourceIp ?? current.sourceIp,
        endpointHost: address.endpointHost ?? current.endpointHost,
        lastUsedAt: usedAt,
        useCount: current.useCount + 1,
      }
    : {
        poolId: options.poolId,
        nodeId: options.node.id,
        target: options.target,
        sourceIp: address.sourceIp,
        endpointHost: address.endpointHost,
        firstUsedAt: usedAt,
        lastUsedAt: usedAt,
        useCount: 1,
      }

  return {
    schemaVersion: 1,
    updatedAt: usedAt,
    blockedNodes: state.blockedNodes,
    usedNodes: [
      ...existing.filter(record => record !== current),
      nextRecord,
    ],
  }
}

export function selectNextEgressNode(
  config: EgressConfig,
  state: EgressState,
  options: {
    poolId: string
    currentNodeId?: string
    target?: string
    now?: Date
    avoidUsedForTarget?: boolean
  },
): EgressSwitchPlan {
  const now = options.now ?? new Date()
  const pool = (config.egressPools ?? []).find(item => item.id === options.poolId)
  if (!pool) {
    return {
      poolId: options.poolId,
      currentNodeId: options.currentNodeId,
      target: options.target,
      message: `Egress pool ${options.poolId} was not found.`,
    }
  }

  const nextNode = (pool.nodes ?? []).find(node => {
    if (!node.id || node.enabled === false) return false
    if (options.currentNodeId && node.id === options.currentNodeId) return false
    if (
      options.avoidUsedForTarget &&
      nodeWasUsedForTarget(state, options.poolId, node, options.target)
    ) {
      return false
    }
    return !nodeIsBlocked(state, options.poolId, node.id, options.target, now)
  })

  if (!nextNode) {
    return {
      poolId: options.poolId,
      currentNodeId: options.currentNodeId,
      target: options.target,
      message:
        options.avoidUsedForTarget
          ? 'No unused approved egress node is currently available for this target; pause the run and add or approve another node before continuing.'
          : 'No alternate approved egress node is currently available; pause the run and add or approve another node before continuing.',
    }
  }

  return {
    poolId: options.poolId,
    currentNodeId: options.currentNodeId,
    target: options.target,
    nextNode,
    message: `Switching to approved egress node ${nextNode.id}.`,
  }
}

function endpointHostPort(
  endpoint: string | undefined,
): { host: string; port: number } | undefined {
  if (!endpoint) return undefined
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return undefined
  }

  const defaultPort =
    parsed.protocol === 'http:'
      ? 80
      : parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:'
          ? 1080
          : undefined
  const port = parsed.port ? Number(parsed.port) : defaultPort
  if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined
  }
  return { host: parsed.hostname, port }
}

async function checkEndpointConnectivity(
  node: EgressNode,
  timeoutMs: number,
): Promise<EgressNodeConnectivity> {
  const destination = endpointHostPort(node.endpoint)
  if (!destination) {
    return { reachable: false, error: 'invalid endpoint' }
  }

  const startedAt = Date.now()
  return new Promise(resolve => {
    let settled = false
    const socket = net.createConnection(destination)
    const settle = (result: EgressNodeConnectivity) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      settle({ reachable: true, latencyMs: Date.now() - startedAt })
    })
    socket.once('timeout', () => {
      settle({ reachable: false, error: `timeout after ${timeoutMs}ms` })
    })
    socket.once('error', error => {
      settle({ reachable: false, error: error.message })
    })
  })
}

export async function selectHealthyEgressNode(
  config: EgressConfig,
  state: EgressState,
  options: {
    poolId: string
    currentNodeId?: string
    target?: string
    timeoutMs: number
    now?: Date
    avoidUsedForTarget?: boolean
  },
): Promise<EgressHealthResult> {
  const now = options.now ?? new Date()
  const pool = (config.egressPools ?? []).find(item => item.id === options.poolId)
  const nodes: EgressHealthNode[] = []
  if (!pool) {
    return {
      poolId: options.poolId,
      target: options.target,
      nodes,
      message: `Egress pool ${options.poolId} was not found.`,
    }
  }

  for (const node of pool.nodes ?? []) {
    const nodeId = node.id ?? '<missing-id>'
    const base = {
      poolId: options.poolId,
      nodeId,
      endpoint: node.endpoint,
    }
    if (!node.id || node.enabled === false) {
      nodes.push({
        ...base,
        reachable: false,
        skippedReason: 'node disabled or missing id',
      })
      continue
    }
    if (options.currentNodeId && node.id === options.currentNodeId) {
      nodes.push({
        ...base,
        reachable: false,
        skippedReason: 'current node excluded',
      })
      continue
    }
    if (
      options.avoidUsedForTarget &&
      nodeWasUsedForTarget(state, options.poolId, node, options.target)
    ) {
      nodes.push({
        ...base,
        reachable: false,
        skippedReason: 'node source IP already used for this target',
      })
      continue
    }
    if (nodeIsBlocked(state, options.poolId, node.id, options.target, now)) {
      nodes.push({
        ...base,
        reachable: false,
        skippedReason: 'node is in blocked cooldown for this target',
      })
      continue
    }

    const connectivity = await checkEndpointConnectivity(node, options.timeoutMs)
    nodes.push({ ...base, ...connectivity })
    if (connectivity.reachable) {
      return {
        poolId: options.poolId,
        target: options.target,
        selectedNode: node,
        nodes,
        message: `Selected reachable approved egress node ${node.id}.`,
      }
    }
  }

  return {
    poolId: options.poolId,
    target: options.target,
    nodes,
    message:
      'No reachable approved egress node is currently available; keep the run paused or add another referee-approved node.',
  }
}

export async function loadEgressConfig(configPath: string): Promise<EgressConfig> {
  const text = await readFile(resolveFromRepo(configPath), 'utf8')
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error('Egress config must be a JSON object')
  }
  return parsed as EgressConfig
}

export function validateEgressConfig(
  config: EgressConfig,
  options: {
    now?: Date
    configPath?: string
    poolId?: string
    target?: string
  } = {},
): EgressValidationResult {
  const now = options.now ?? new Date()
  const issues: ValidationIssue[] = []
  const pools = (config.egressPools ?? []).filter(pool =>
    options.poolId ? pool.id === options.poolId : true,
  )

  if (!Array.isArray(config.egressPools) || config.egressPools.length === 0) {
    addIssue(
      issues,
      'error',
      'egressPools',
      'at least one egress pool is required',
    )
  }

  if (options.poolId && pools.length === 0) {
    addIssue(
      issues,
      'error',
      'egressPools',
      `pool ${options.poolId} was not found`,
    )
  }

  const requireAuthorization = config.policy?.requireAuthorization !== false
  const disallowPublicFreeProxies =
    config.policy?.disallowPublicFreeProxies !== false
  const disallowUnverifiedNodes =
    config.policy?.disallowUnverifiedNodes !== false

  validateConfigFreshness(config, now, issues)

  if (!disallowPublicFreeProxies) {
    addIssue(
      issues,
      'error',
      'policy.disallowPublicFreeProxies',
      'public free proxy collection must stay disabled',
    )
  }

  const poolSummaries = pools.map((pool, poolIndex): PoolSummary => {
    const poolPath = `egressPools[${poolIndex}]`
    const poolIssues: ValidationIssue[] = []
    const nodes = pool.nodes ?? []

    if (!hasText(pool.id)) {
      addIssue(poolIssues, 'error', `${poolPath}.id`, 'pool id is required')
    }
    if (!hasText(pool.owner)) {
      addIssue(poolIssues, 'error', `${poolPath}.owner`, 'owner is required')
    }
    if (requireAuthorization) {
      validateAuthorization(
        pool.authorization,
        `${poolPath}.authorization`,
        now,
        poolIssues,
      )
    }

    validateRateLimits(pool.rateLimits, `${poolPath}.rateLimits`, poolIssues)

    if (countTargets(pool.allowedTargets) === 0) {
      addIssue(
        poolIssues,
        'error',
        `${poolPath}.allowedTargets`,
        'allowedTargets must contain at least one URL, domain, IP, or CIDR',
      )
    }

    if (options.target && !targetAllowedByPool(options.target, pool)) {
      addIssue(
        poolIssues,
        'error',
        `${poolPath}.allowedTargets`,
        `target ${options.target} is not authorized for this egress pool`,
      )
    }

    if (!Array.isArray(nodes) || nodes.length === 0) {
      addIssue(poolIssues, 'error', `${poolPath}.nodes`, 'nodes are required')
    } else {
      const seenIds = new Set<string>()
      nodes.forEach((node, nodeIndex) => {
        const nodePath = `${poolPath}.nodes[${nodeIndex}]`
        if (node.id) {
          if (seenIds.has(node.id)) {
            addIssue(
              poolIssues,
              'error',
              `${nodePath}.id`,
              `duplicate node id ${node.id}`,
            )
          }
          seenIds.add(node.id)
        }
        validateNode(
          node,
          nodePath,
          pool.restrictions?.disallowUnverifiedNodes ??
            disallowUnverifiedNodes,
          poolIssues,
        )
      })
    }

    if (!disallowPublicFreeProxies) {
      addIssue(
        poolIssues,
        'error',
        `${poolPath}.restrictions.disallowPublicFreeProxies`,
        'public free proxy collection must stay disabled',
      )
    }

    issues.push(...poolIssues)

    return {
      id: pool.id ?? `<missing-${poolIndex}>`,
      name: pool.name,
      owner: pool.owner,
      nodeCount: nodes.length,
      enabledNodeCount: nodes.filter(node => node.enabled !== false).length,
      allowedTargetCount: countTargets(pool.allowedTargets),
      status: poolIssues.some(issue => issue.severity === 'error')
        ? 'error'
        : 'ok',
      issues: poolIssues,
    }
  })

  const hasErrors = issues.some(issue => issue.severity === 'error')
  return {
    status: hasErrors ? 'error' : 'ok',
    canUse: !hasErrors,
    generatedAt: new Date().toISOString(),
    configPath: options.configPath,
    pools: poolSummaries,
    issues,
  }
}

function findNode(
  config: EgressConfig,
  poolId: string,
  nodeId: string,
): { pool?: EgressPool; node?: EgressNode } {
  const pool = (config.egressPools ?? []).find(item => item.id === poolId)
  const node = (pool?.nodes ?? []).find(item => item.id === nodeId)
  return { pool, node }
}

export function proxyEnvForNode(node: EgressNode): Record<string, string> {
  if (!node.endpoint) return {}
  const env: Record<string, string> = {}
  const parsed = new URL(node.endpoint)
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    env.HTTP_PROXY = node.endpoint
    env.HTTPS_PROXY = node.endpoint
    env.http_proxy = node.endpoint
    env.https_proxy = node.endpoint
  } else {
    env.HTTP_PROXY = node.endpoint
    env.HTTPS_PROXY = node.endpoint
    env.ALL_PROXY = node.endpoint
    env.http_proxy = node.endpoint
    env.https_proxy = node.endpoint
    env.all_proxy = node.endpoint
  }
  if (node.authEnv) env.REDSCOPE_EGRESS_AUTH_ENV = node.authEnv
  return env
}

function printHumanResult(result: EgressValidationResult): void {
  console.log(`Egress config: ${result.status}`)
  for (const pool of result.pools) {
    console.log(
      `- ${pool.id}: ${pool.status} (${pool.enabledNodeCount}/${pool.nodeCount} enabled nodes, ${pool.allowedTargetCount} allowed targets)`,
    )
    for (const issue of pool.issues) {
      console.log(`  ${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`)
    }
  }
  for (const issue of result.issues.filter(
    issue => !issue.path.startsWith('egressPools['),
  )) {
    console.log(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`)
  }
}

function printList(config: EgressConfig, poolId?: string): void {
  const pools = (config.egressPools ?? []).filter(pool =>
    poolId ? pool.id === poolId : true,
  )
  for (const pool of pools) {
    console.log(`${pool.id ?? '<missing-id>'} - ${pool.name ?? 'Unnamed pool'}`)
    for (const node of pool.nodes ?? []) {
      const state = node.enabled === false ? 'disabled' : 'enabled'
      console.log(
        `  ${node.id ?? '<missing-id>'} ${state} ${node.kind ?? '<missing-kind>'} ${node.endpoint ?? '<missing-endpoint>'}`,
      )
    }
  }
}

function printSwitchPlan(
  plan: EgressSwitchPlan,
  options: { blocked?: boolean; statusCode?: number; reason?: string },
): void {
  if (options.blocked) {
    const statusText = options.statusCode ? `HTTP ${options.statusCode}` : 'a block signal'
    const reasonText = options.reason ? ` (${options.reason})` : ''
    console.log(
      `RedScope detected target-side egress blocking for ${plan.currentNodeId ?? 'the current node'}: ${statusText}${reasonText}.`,
    )
    console.log(
      'Only pre-approved egress nodes from the engagement config will be considered.',
    )
  }
  console.log(plan.message)
  if (plan.nextNode) {
    console.log(
      `Next approved node: ${plan.nextNode.id} ${plan.nextNode.kind ?? ''} ${plan.nextNode.endpoint ?? ''}`.trim(),
    )
  }
}

function printHealthResult(result: EgressHealthResult): void {
  console.log(result.message)
  for (const node of result.nodes) {
    const details = node.reachable
      ? `reachable ${node.latencyMs ?? '?'}ms`
      : node.skippedReason
        ? `skipped: ${node.skippedReason}`
        : `unreachable: ${node.error ?? 'unknown error'}`
    console.log(`- ${node.nodeId}: ${details}`)
  }
  if (result.selectedNode) {
    console.log(
      `Selected node: ${result.selectedNode.id} ${result.selectedNode.kind ?? ''} ${result.selectedNode.endpoint ?? ''}`.trim(),
    )
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const config = await loadEgressConfig(options.configPath)
  const configPath = resolveFromRepo(options.configPath)
  const statePath = options.statePathFromCli
    ? options.statePath
    : config.policy?.statePath ?? options.statePath

  const result = validateEgressConfig(config, {
    configPath,
    poolId: options.poolId,
    target: options.target,
  })

  if (options.command === 'blocked') {
    if (!result.canUse) {
      if (options.json) {
        console.log(JSON.stringify({ result, switchPlan: null, env: null }, null, 2))
      } else {
        printHumanResult(result)
      }
      process.exit(1)
    }

    const now = new Date()
    const state = await readEgressState(statePath)
    const blockedCooldownHours = config.policy?.blockedCooldownHours ?? 24
    const updatedState = recordBlockedEgressNode(state, {
      poolId: options.poolId!,
      nodeId: options.nodeId!,
      target: options.target,
      statusCode: options.statusCode,
      reason: options.reason,
      blockedCooldownHours,
      now,
    })
    await writeEgressState(statePath, updatedState)
    const switchPlan = selectNextEgressNode(config, updatedState, {
      poolId: options.poolId!,
      currentNodeId: options.nodeId,
      target: options.target,
      now,
    })
    const env = switchPlan.nextNode && options.emitEnv
      ? proxyEnvForNode(switchPlan.nextNode)
      : null
    if (options.json) {
      console.log(JSON.stringify({ result, switchPlan, env }, null, 2))
    } else {
      printSwitchPlan(switchPlan, {
        blocked: true,
        statusCode: options.statusCode,
        reason: options.reason,
      })
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          console.log(`${key}=${value}`)
        }
      }
    }
    return
  }

  if (options.command === 'health') {
    if (!result.canUse) {
      if (options.json) {
        console.log(JSON.stringify({ result, health: null, env: null }, null, 2))
      } else {
        printHumanResult(result)
      }
      process.exit(1)
    }

    const state = await readEgressState(statePath)
    const health = await selectHealthyEgressNode(config, state, {
      poolId: options.poolId!,
      currentNodeId: options.nodeId,
      target: options.target,
      timeoutMs: options.timeoutMs,
    })
    const env = health.selectedNode && options.emitEnv
      ? proxyEnvForNode(health.selectedNode)
      : null
    if (options.json) {
      console.log(JSON.stringify({ result, health, env }, null, 2))
    } else {
      printHealthResult(health)
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          console.log(`${key}=${value}`)
        }
      }
    }
    return
  }

  if (options.command === 'next') {
    if (!result.canUse) {
      if (options.json) {
        console.log(JSON.stringify({ result, switchPlan: null, env: null }, null, 2))
      } else {
        printHumanResult(result)
      }
      process.exit(1)
    }

    const state = await readEgressState(statePath)
    const switchPlan = selectNextEgressNode(config, state, {
      poolId: options.poolId!,
      currentNodeId: options.nodeId,
      target: options.target,
    })
    const env = switchPlan.nextNode && options.emitEnv
      ? proxyEnvForNode(switchPlan.nextNode)
      : null
    if (options.json) {
      console.log(JSON.stringify({ result, switchPlan, env }, null, 2))
    } else {
      printSwitchPlan(switchPlan, { blocked: false })
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          console.log(`${key}=${value}`)
        }
      }
    }
    return
  }

  if (options.emitEnv) {
    const { node } = findNode(config, options.poolId!, options.nodeId!)
    if (!node) {
      console.error('Selected egress node was not found')
      process.exit(1)
    }
    if (!result.canUse) {
      if (options.json) {
        console.log(JSON.stringify({ result, env: null }, null, 2))
      } else {
        printHumanResult(result)
      }
      process.exit(1)
    }

    const env = proxyEnvForNode(node)
    if (options.json) {
      console.log(JSON.stringify({ result, env }, null, 2))
    } else {
      for (const [key, value] of Object.entries(env)) {
        console.log(`${key}=${value}`)
      }
    }
    return
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (options.command === 'list') {
    printList(config, options.poolId)
  } else {
    printHumanResult(result)
  }

  if (options.strict && !result.canUse) process.exit(1)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
