#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { envList, envPathFrom } from './redscope-env-config.ts'
import {
  type AuthorizedEgressSession,
  authorizedEgressEnv,
  createAuthorizedEgressSession,
  fetchWithAuthorizedEgress,
  isTargetSideEgressBlockStatus,
  recordBlockAndSwitchAuthorizedEgress,
  restoreAuthorizedEgressEnv,
  writeAuthorizedEgressManifest,
} from './redscope-egress-runtime.ts'

type RiskLevel = 'passive' | 'baseline' | 'active' | 'restricted' | string

type ProfileStep = {
  id: string
  kind: 'internal' | 'internal-http-baseline' | 'tool' | string
  tool?: string
  description: string
}

type RunProfile = {
  id: string
  name: string
  riskLevel: RiskLevel
  description: string
  targetKinds: string[]
  requiredAuthorizationFields: string[]
  allowedTools: string[]
  rateLimits: {
    requestsPerSecond: number
    concurrency: number
    maxTargets: number
  }
  outputDirectory: string
  stopConditions: string[]
  reportTemplate: string
  steps: ProfileStep[]
}

type ProfileRegistry = {
  schemaVersion?: number
  generatedAt?: string
  policy?: {
    outputRoot?: string
    defaultExecution?: string
    requiresScope?: boolean
    requiresExecuteFlag?: boolean
    requiresActiveConfirmationForLevels?: string[]
    notes?: string[]
  }
  profiles?: RunProfile[]
}

type ScopeFile = {
  program?: string
  owner?: string
  authorization?: {
    authorizedBy?: string
    reference?: string
    validFrom?: string
    validTo?: string
    emergencyContact?: string
  }
  testLevels?: string[]
  rateLimits?: {
    requestsPerSecond?: number
    concurrency?: number
  }
  scannerExecution?: {
    approvedBy?: string
    approvalReference?: string
    changeWindow?: string
    allowedTools?: string[]
    notes?: string[]
  }
  targets?: {
    organizations?: string[]
    domains?: string[]
    urls?: string[]
    ips?: string[]
    cidrs?: string[]
    repositories?: string[]
    artifacts?: string[]
  }
  exclusions?: {
    domains?: string[]
    urls?: string[]
    ips?: string[]
    cidrs?: string[]
    artifacts?: string[]
  }
  validation?: {
    approvedBy?: string
    approvalReference?: string
    validators?: Array<{
      id?: string
      title?: string
      target?: string
      method?: string
      requestMethod?: string
      path?: string
      header?: string
      expectedStatus?: number
      expected?: string
      severity?: string
      category?: string
      impact?: string
      remediation?: string
      references?: string[]
      candidateCves?: string[]
      cpe23Names?: string[]
      notes?: string[]
      approvedBy?: string
      approvalReference?: string
    }>
  }
  logicValidation?: {
    approvedBy?: string
    approvalReference?: string
    stateChangingApproval?: {
      approvedBy?: string
      approvalReference?: string
      changeWindow?: string
      rollbackPlan?: string
      maxMutatingRequests?: number
      notes?: string[]
    }
    actorSessions?: Array<{
      id?: string
      role?: string
      headerEnv?: string
      headerName?: string
      login?: {
        url?: string
        path?: string
        method?: string
        contentType?: string
        usernameEnv?: string
        passwordEnv?: string
        usernameField?: string
        passwordField?: string
        extraFields?: Record<string, string>
        tokenJsonPath?: string
        tokenPrefix?: string
        cookieNames?: string[]
        successStatuses?: number[]
        notes?: string[]
      }
      notes?: string[]
    }>
    testCases?: Array<{
      id?: string
      title?: string
      category?: string
      validationMode?: string
      target?: string
      path?: string
      method?: string
      controlActor?: string
      testActor?: string
      objectOwnerActor?: string
      affectedObject?: string
      expectedControlStatuses?: number[]
      expectedDeniedStatuses?: number[]
      vulnerableStatuses?: number[]
      expectedBodyMarker?: string
      requestContentType?: string
      requestBody?: unknown
      requestBodyEnv?: string
      requestBodySha256?: string
      preconditionEvidenceRefs?: string[]
      rollbackPlan?: string
      expectedOutcome?: string
      observedOutcome?: string
      observedImpact?: boolean
      evidenceRefs?: string[]
      severity?: string
      impact?: string
      remediation?: string
      references?: string[]
      cweIds?: string[]
      notes?: string[]
      approvedBy?: string
      approvalReference?: string
      parallelGroup?: string
      isolatedTestFamily?: string
    }>
  }
  technologyEvidence?: Array<{
    target?: string
    vendor?: string
    product?: string
    version?: string
    cpe23Name?: string
    cpe?: string
    source?: string
    evidenceId?: string
    observedAt?: string
    confidence?: string
    notes?: string[]
  }>
  notes?: string[]
}

type ToolManifest = {
  generatedAt?: string
  tool?: {
    id?: string
    name?: string
    riskLevel?: string
  }
  install?: {
    version?: string
    executablePath?: string | null
    installDir?: string
  }
  checksum?: {
    sha256?: string
    verified?: boolean
    source?: string
  }
  authorization?: {
    executionDisabledByDefault?: boolean
  }
}

type Options = {
  command: 'list' | 'run'
  profileId?: string
  scopePath?: string
  target?: string
  repository?: string
  artifact?: string
  profilesPath: string
  outputRoot?: string
  dryRun: boolean
  execute: boolean
  force: boolean
  json: boolean
  confirmActive: boolean
  semgrepConfig?: string
}

type TargetPlan = {
  raw: string
  kind: string
  normalizedHost?: string
  normalizedUrl?: string
  repositoryPath?: string
  artifactPath?: string
  matchedBy: string[]
}

type PlannedCommand = {
  stepId: string
  tool?: string
  kind: string
  argv: string[]
  cwd: string
  outputFiles: string[]
  status: 'planned' | 'skipped' | 'executed' | 'failed'
  reason?: string
  exitCode?: number
  egress?: {
    enabled: boolean
    poolId?: string
    nodeId?: string
    switchCount?: number
    validateBeforeUse?: boolean
    avoidUsedForTarget?: boolean
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultProfilesPath = envPathFrom(
  ['REDSCOPE_TOOLS_PROFILE_REGISTRY', 'REDSCOPE_PROFILE_REGISTRY'],
  'tools/redscope-run-profiles.json',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-profile-runner.ts --list
  bun run scripts/redscope-profile-runner.ts --profile <id> --scope <scope.json> --target <url|domain|company> [options]
  bun run scripts/redscope-profile-runner.ts --profile repo-secret-and-sast --scope <scope.json> --repository <path> [options]
  bun run scripts/redscope-profile-runner.ts --profile threat-trace-artifact-review --scope <scope.json> --artifact <path> [options]

Modes:
  default                  Create a project-local run plan, but do not execute tools
  --dry-run                Validate and print the run plan without writing files
  --execute                Execute deterministic internal/tool-backed steps

Safety:
  --confirm-active         Required with --execute for active/restricted profiles
  --semgrep-config <path>  Local semgrep config for repo-secret-and-sast execution

Other:
  --profiles <path>        Profile registry path (default: ${defaultProfilesPath})
  --output-root <path>     Override run output root
  --force                  Reuse an existing run directory when generated
  --json                   Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'run',
    profilesPath: defaultProfilesPath,
    dryRun: false,
    execute: false,
    force: false,
    json: false,
    confirmActive: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === 'list' || arg === '--list') {
      options.command = 'list'
      continue
    }
    if (arg === 'run') {
      options.command = 'run'
      continue
    }
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--execute') {
      options.execute = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--confirm-active') {
      options.confirmActive = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--profile':
        options.profileId = next
        break
      case '--scope':
        options.scopePath = next
        break
      case '--target':
        options.target = next
        break
      case '--repository':
        options.repository = next
        break
      case '--artifact':
        options.artifact = next
        break
      case '--profiles':
        options.profilesPath = next
        break
      case '--output-root':
        options.outputRoot = next
        break
      case '--semgrep-config':
        options.semgrepConfig = next
        break
      default:
        usage()
    }
    index++
  }

  return options
}

function projectPath(path: string): string {
  const relativePath = relative(repoRoot, path).split(sep).join('/')
  return relativePath || '.'
}

function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)
}

function assertInside(child: string, parent: string, label: string) {
  const relativePath = relative(parent, child)
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  ) {
    return
  }
  throw new Error(`${label} must stay inside ${projectPath(parent)}`)
}

function pathInsideOrEqual(child: string, parent: string): boolean {
  const relation = relative(parent, child)
  return child === parent || (!relation.startsWith('..') && !isAbsolute(relation))
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined
  return readJsonFile<T>(path)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function walkFilesBounded(
  root: string,
  options: {
    maxFiles: number
    allowedExtensions: Set<string>
  },
): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const files: string[] = []

  async function walk(path: string) {
    if (files.length >= options.maxFiles) return
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) {
        if (
          ['.git', 'node_modules', '.venv', 'vendor', 'dist', 'build'].includes(
            entry.name,
          )
        ) {
          continue
        }
        await walk(fullPath)
      } else if (
        entry.isFile() &&
        options.allowedExtensions.has(extname(entry.name).toLowerCase())
      ) {
        files.push(fullPath)
      }
    }
  }

  await walk(root)
  return files
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim())
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function riskRank(level: string): number {
  switch (level) {
    case 'passive':
      return 1
    case 'baseline':
      return 2
    case 'active':
      return 3
    case 'restricted':
      return 4
    default:
      return -1
  }
}

function scopeAllowsRisk(scope: ScopeFile, riskLevel: string): boolean {
  const allowed = Array.isArray(scope.testLevels) ? scope.testLevels : []
  if (riskLevel === 'restricted') return allowed.includes('restricted')
  const requiredRank = riskRank(riskLevel)
  return allowed.some(level => riskRank(level) >= requiredRank)
}

function getPathValue(root: unknown, dottedPath: string): unknown {
  if (dottedPath.startsWith('testLevels.')) {
    const level = dottedPath.slice('testLevels.'.length)
    return list((root as ScopeFile).testLevels).includes(level)
  }

  const parts = dottedPath.split('.')
  let cursor: unknown = root
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function valuePresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return value
  return value != null
}

function missingRequiredFields(scope: ScopeFile, profile: RunProfile): string[] {
  const missing: string[] = []
  for (const requirement of profile.requiredAuthorizationFields) {
    const alternatives = requirement.split('|')
    const satisfied = alternatives.some(path => valuePresent(getPathValue(scope, path)))
    if (!satisfied) missing.push(requirement)
  }
  return missing
}

function parseDateOnly(value: string, endOfDay: boolean): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'
  const date = new Date(`${value}${suffix}`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function validateAuthorizationWindow(scope: ScopeFile) {
  const validFromRaw = scope.authorization?.validFrom
  const validToRaw = scope.authorization?.validTo
  if (!validFromRaw || !validToRaw) return

  const validFrom = parseDateOnly(validFromRaw, false)
  const validTo = parseDateOnly(validToRaw, true)
  if (!validFrom || !validTo) {
    throw new Error('authorization.validFrom and validTo must use YYYY-MM-DD')
  }

  const now = new Date()
  if (now < validFrom) {
    throw new Error(`authorization window has not started (${validFromRaw})`)
  }
  if (now > validTo) {
    throw new Error(`authorization window expired (${validToRaw})`)
  }
}

function normalizeHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return value.trim().replace(/\.$/, '').toLowerCase()
  }
}

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined
  }
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0)
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/')
  const prefix = Number(prefixRaw)
  const ipInt = ipv4ToInt(ip)
  const baseInt = ipv4ToInt(base)
  if (
    ipInt == null ||
    baseInt == null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = normalizeHost(host)
  const normalizedDomain = normalizeHost(domain)
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  )
}

function targetMatchesUrl(target: string, allowedUrl: string): boolean {
  const normalizedTarget = normalizeUrl(target)
  const normalizedAllowed = normalizeUrl(allowedUrl)
  if (!normalizedTarget || !normalizedAllowed) return false

  const targetUrl = new URL(normalizedTarget)
  const allowed = new URL(normalizedAllowed)
  if (
    targetUrl.protocol !== allowed.protocol ||
    targetUrl.hostname !== allowed.hostname
  ) {
    return false
  }
  return targetUrl.pathname.startsWith(allowed.pathname)
}

function inferTargetKind(raw: string, repositoryMode: boolean): string {
  if (repositoryMode) return 'repository'
  const normalizedUrl = normalizeUrl(raw)
  if (normalizedUrl) return 'url'
  if (net.isIP(normalizeHost(raw)) !== 0) return 'ip'
  return 'domain'
}

function resolveDefaultTarget(scope: ScopeFile, profile: RunProfile): string | undefined {
  if (profile.targetKinds.includes('organization')) {
    const organization = list(scope.targets?.organizations)[0]
    if (organization) return organization
  }
  if (profile.targetKinds.includes('url')) {
    const url = list(scope.targets?.urls)[0]
    if (url) return url
  }
  if (profile.targetKinds.includes('domain')) {
    const domain = list(scope.targets?.domains)[0]
    if (domain) return domain
  }
  if (profile.targetKinds.includes('artifact')) {
    const artifact = list(scope.targets?.artifacts)[0]
    if (artifact) return artifact
  }
  return undefined
}

function validateRepositoryTarget(scope: ScopeFile, repositoryRaw: string): TargetPlan {
  const repositoryPath = resolveProjectPath(repositoryRaw)
  assertInside(repositoryPath, repoRoot, 'repository target')

  const scopedRepositories = list(scope.targets?.repositories).map(item =>
    resolveProjectPath(item),
  )
  if (scopedRepositories.length === 0) {
    throw new Error('scope targets.repositories is required for repository profiles')
  }

  const matchedBy: string[] = []
  for (const scoped of scopedRepositories) {
    if (pathInsideOrEqual(repositoryPath, scoped)) {
      matchedBy.push('targets.repositories')
      break
    }
  }

  if (matchedBy.length === 0) {
    throw new Error(`${projectPath(repositoryPath)} is not listed in scope targets.repositories`)
  }

  return {
    raw: repositoryRaw,
    kind: 'repository',
    repositoryPath,
    matchedBy,
  }
}

function validateArtifactTarget(scope: ScopeFile, artifactRaw: string): TargetPlan {
  const artifactPath = resolveProjectPath(artifactRaw)
  assertInside(artifactPath, repoRoot, 'artifact target')

  const scopedArtifacts = list(scope.targets?.artifacts).map(item => {
    const resolved = resolveProjectPath(item)
    assertInside(resolved, repoRoot, 'scope artifact target')
    return resolved
  })
  if (scopedArtifacts.length === 0) {
    throw new Error('scope targets.artifacts is required for artifact profiles')
  }

  const excluded = list(scope.exclusions?.artifacts).some(item => {
    const resolved = resolveProjectPath(item)
    assertInside(resolved, repoRoot, 'scope artifact exclusion')
    return pathInsideOrEqual(artifactPath, resolved)
  })
  if (excluded) throw new Error('artifact is explicitly excluded by scope')

  const matchedBy: string[] = []
  for (const scoped of scopedArtifacts) {
    if (pathInsideOrEqual(artifactPath, scoped)) {
      matchedBy.push('targets.artifacts')
      break
    }
  }

  if (matchedBy.length === 0) {
    throw new Error(`${projectPath(artifactPath)} is not listed in scope targets.artifacts`)
  }

  return {
    raw: artifactRaw,
    kind: 'artifact',
    artifactPath,
    matchedBy,
  }
}

function validateNetworkTarget(scope: ScopeFile, target: string): TargetPlan {
  const host = normalizeHost(target)
  const isIp = net.isIP(host) !== 0
  const normalizedUrl = normalizeUrl(target)
  const targets = scope.targets ?? {}
  const exclusions = scope.exclusions ?? {}

  const excluded =
    list(exclusions.urls).some(url => targetMatchesUrl(target, url)) ||
    list(exclusions.domains).some(domain => hostMatchesDomain(host, domain)) ||
    list(exclusions.ips).includes(host) ||
    (isIp && list(exclusions.cidrs).some(cidr => ipInCidr(host, cidr)))

  if (excluded) throw new Error('target is explicitly excluded by scope')

  const matchedBy: string[] = []
  if (normalizedUrl && list(targets.urls).some(url => targetMatchesUrl(target, url))) {
    matchedBy.push('targets.urls')
  }
  if (list(targets.domains).some(domain => hostMatchesDomain(host, domain))) {
    matchedBy.push('targets.domains')
  }
  if (isIp && list(targets.ips).includes(host)) {
    matchedBy.push('targets.ips')
  }
  if (isIp && list(targets.cidrs).some(cidr => ipInCidr(host, cidr))) {
    matchedBy.push('targets.cidrs')
  }
  if (
    list(targets.organizations).some(
      name => name.toLowerCase() === target.toLowerCase(),
    )
  ) {
    matchedBy.push('targets.organizations')
  }

  if (matchedBy.length === 0) {
    throw new Error('target is not listed in scope')
  }

  return {
    raw: target,
    kind: inferTargetKind(target, false),
    normalizedHost: host,
    normalizedUrl,
    matchedBy,
  }
}

function validateTarget(
  scope: ScopeFile,
  profile: RunProfile,
  options: Options,
): TargetPlan {
  const selectedTargetModes = [
    options.repository,
    options.artifact,
  ].filter(Boolean).length
  if (selectedTargetModes > 1) {
    throw new Error('choose either --repository or --artifact, not both')
  }

  if (options.repository) {
    if (!profile.targetKinds.includes('repository')) {
      throw new Error(`${profile.id} does not accept repository targets`)
    }
    return validateRepositoryTarget(scope, options.repository)
  }

  if (options.artifact || profile.targetKinds.includes('artifact')) {
    if (!profile.targetKinds.includes('artifact')) {
      throw new Error(`${profile.id} does not accept artifact targets`)
    }
    const artifact = options.artifact ?? options.target ?? resolveDefaultTarget(scope, profile)
    if (!artifact) throw new Error('--artifact is required for this profile')
    return validateArtifactTarget(scope, artifact)
  }

  const target = options.target ?? resolveDefaultTarget(scope, profile)
  if (!target) throw new Error('--target is required for this profile')

  const plan = validateNetworkTarget(scope, target)
  const acceptsOrganization =
    profile.targetKinds.includes('organization') &&
    plan.matchedBy.includes('targets.organizations')
  const acceptsKind = profile.targetKinds.includes(plan.kind)
  const acceptsDomainForUrl =
    plan.kind === 'url' &&
    profile.targetKinds.includes('domain') &&
    plan.matchedBy.includes('targets.domains')

  if (!acceptsKind && !acceptsOrganization && !acceptsDomainForUrl) {
    throw new Error(
      `${profile.id} does not accept ${plan.kind} targets; allowed: ${profile.targetKinds.join(', ')}`,
    )
  }
  return plan
}

function validateScope(scope: ScopeFile, profile: RunProfile) {
  const missing = missingRequiredFields(scope, profile)
  if (missing.length > 0) {
    throw new Error(`scope is missing required fields: ${missing.join(', ')}`)
  }
  validateAuthorizationWindow(scope)
  if (!scopeAllowsRisk(scope, profile.riskLevel)) {
    throw new Error(
      `scope testLevels do not allow "${profile.riskLevel}" profile ${profile.id}`,
    )
  }
}

function effectiveRateLimits(scope: ScopeFile, profile: RunProfile) {
  const profileRps = profile.rateLimits.requestsPerSecond
  const scopeRps = scope.rateLimits?.requestsPerSecond
  const requestsPerSecond =
    profileRps === 0
      ? 0
      : Math.min(profileRps, Number.isFinite(scopeRps) ? Number(scopeRps) : profileRps)

  const profileConcurrency = profile.rateLimits.concurrency
  const scopeConcurrency = scope.rateLimits?.concurrency
  const concurrency = Math.max(
    1,
    Math.min(
      profileConcurrency,
      Number.isFinite(scopeConcurrency)
        ? Number(scopeConcurrency)
        : profileConcurrency,
    ),
  )

  return {
    requestsPerSecond,
    concurrency,
    maxTargets: profile.rateLimits.maxTargets,
  }
}

function sanitizeRunPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function runId(profile: RunProfile, target: TargetPlan): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetPart = sanitizeRunPart(
    target.repositoryPath
      ? basename(target.repositoryPath)
      : target.artifactPath
        ? basename(target.artifactPath)
        : target.raw,
  )
  return `${stamp}-${profile.id}${targetPart ? `-${targetPart}` : ''}`
}

async function loadProfiles(path: string): Promise<ProfileRegistry> {
  const registry = await readJsonFile<ProfileRegistry>(path)
  if (!Array.isArray(registry.profiles)) {
    throw new Error('profile registry is missing a profiles array')
  }
  return registry
}

function findProfile(registry: ProfileRegistry, id: string): RunProfile {
  const profile = registry.profiles?.find(item => item.id === id)
  if (!profile) throw new Error(`unknown profile "${id}". Run with --list first.`)
  return profile
}

function listProfiles(registry: ProfileRegistry, json: boolean) {
  const profiles = registry.profiles ?? []
  if (json) {
    console.log(JSON.stringify(profiles, null, 2))
    return
  }

  console.log('id\trisk\ttargets\ttools')
  for (const profile of profiles) {
    console.log(
      `${profile.id}\t${profile.riskLevel}\t${profile.targetKinds.join(',')}\t${profile.allowedTools.join(',') || '-'}`,
    )
  }
}

async function findToolManifest(toolId: string): Promise<ToolManifest | undefined> {
  const manifestDir = resolveProjectPath('tools/manifests')
  if (!(await pathExists(manifestDir))) return undefined
  const entries = await readdir(manifestDir)
  const manifests: ToolManifest[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const fullPath = join(manifestDir, entry)
    try {
      const manifest = await readJsonFile<ToolManifest>(fullPath)
      if (manifest.tool?.id === toolId && manifest.install?.executablePath) {
        manifests.push(manifest)
      }
    } catch {
      // Ignore malformed manifests; execution will fail closed if no valid one exists.
    }
  }

  manifests.sort((a, b) => {
    const aTime = Date.parse(a.generatedAt ?? '')
    const bTime = Date.parse(b.generatedAt ?? '')
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
  })
  return manifests[0]
}

async function executableForTool(toolId: string): Promise<string | undefined> {
  const manifest = await findToolManifest(toolId)
  const executablePath = manifest?.install?.executablePath
  if (!executablePath) return undefined
  const resolved = resolveProjectPath(executablePath)
  assertInside(resolved, repoRoot, `${toolId} executable`)
  return resolved
}

async function writeText(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function buildTargetsText(target: TargetPlan): string {
  if (target.repositoryPath) return `${projectPath(target.repositoryPath)}\n`
  if (target.artifactPath) return `${projectPath(target.artifactPath)}\n`
  return `${target.normalizedUrl ?? target.raw}\n`
}

function profileUsesTargetEgress(profile: RunProfile, target: TargetPlan): boolean {
  if (target.repositoryPath || target.artifactPath) return false
  return profile.steps.some(
    step =>
      step.kind === 'internal-http-baseline' ||
      step.tool === 'httpx' ||
      step.tool === 'nuclei',
  )
}

function commandUsesTargetEgress(command: PlannedCommand): boolean {
  return command.tool === 'httpx' || command.tool === 'nuclei'
}

function egressRecord(
  session: AuthorizedEgressSession | undefined,
): PlannedCommand['egress'] {
  if (!session) return undefined
  return {
    enabled: session.enabled,
    poolId: session.poolId,
    nodeId: session.currentNode?.id,
    switchCount: session.switchCount,
    validateBeforeUse: session.validateBeforeUse,
    avoidUsedForTarget: session.avoidUsedForTarget,
  }
}

function processEnvRecord(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function spawnEnvForCommand(
  command: PlannedCommand,
  session: AuthorizedEgressSession | undefined,
): Record<string, string> | undefined {
  if (!commandUsesTargetEgress(command) || !session?.enabled) return undefined
  return {
    ...processEnvRecord(),
    ...authorizedEgressEnv(session),
  }
}

async function resetPrimaryToolOutput(command: PlannedCommand): Promise<void> {
  const primary = command.outputFiles[0]
  if (!primary || !commandUsesTargetEgress(command)) return
  await writeText(resolveProjectPath(primary), '')
}

function httpStatusFromRecord(record: Record<string, unknown>): number | undefined {
  for (const key of ['status_code', 'statusCode', 'status']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isInteger(parsed)) return parsed
    }
  }
  return undefined
}

async function toolOutputBlockStatus(
  command: PlannedCommand,
  session: AuthorizedEgressSession | undefined,
): Promise<number | undefined> {
  if (!session?.enabled || command.tool !== 'httpx') return undefined
  const primary = command.outputFiles[0]
  if (!primary) return undefined

  let text = ''
  try {
    text = await readFile(resolveProjectPath(primary), 'utf8')
  } catch {
    return undefined
  }

  const statuses = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map(line => {
      try {
        const parsed = JSON.parse(line) as unknown
        return isRecord(parsed) ? httpStatusFromRecord(parsed) : undefined
      } catch {
        return undefined
      }
    })
    .filter((status): status is number => status !== undefined)

  if (statuses.length === 0) return undefined
  const blocked = statuses.find(status =>
    isTargetSideEgressBlockStatus(status, session.switchOnHttpStatuses),
  )
  if (!blocked) return undefined
  return statuses.every(status =>
    isTargetSideEgressBlockStatus(status, session.switchOnHttpStatuses),
  )
    ? blocked
    : undefined
}

async function localSemgrepConfig(options: Options, repositoryPath: string): Promise<string | undefined> {
  const candidates = [
    options.semgrepConfig,
    join(repositoryPath, '.semgrep.yml'),
    join(repositoryPath, '.semgrep.yaml'),
    join(repositoryPath, 'semgrep.yml'),
    join(repositoryPath, 'semgrep.yaml'),
  ].filter((item): item is string => Boolean(item))

  for (const candidate of candidates) {
    const resolved = resolveProjectPath(candidate)
    if (await pathExists(resolved)) return resolved
  }
  return undefined
}

function profileRequiresScannerExecutionApproval(profile: RunProfile): boolean {
  return profile.requiredAuthorizationFields.some(field =>
    field.startsWith('scannerExecution.'),
  )
}

function scannerToolBlockReasonForStep(
  scope: ScopeFile,
  profile: RunProfile,
  tool: string,
): string | undefined {
  if (!profile.allowedTools.includes(tool)) {
    return `tool ${tool} is not listed in profile.allowedTools`
  }

  if (!profileRequiresScannerExecutionApproval(profile)) return undefined

  const approvedTools = list(scope.scannerExecution?.allowedTools)
  if (!approvedTools.includes(tool)) {
    return `tool ${tool} is not listed in scope.scannerExecution.allowedTools`
  }
  return undefined
}

async function plannedCommandForStep(
  step: ProfileStep,
  profile: RunProfile,
  target: TargetPlan,
  runDir: string,
  limits: ReturnType<typeof effectiveRateLimits>,
  options: Options,
  scope: ScopeFile,
): Promise<PlannedCommand> {
  const cwd = target.repositoryPath ?? repoRoot
  const outputDir = join(runDir, 'raw')
  const targetsFile = join(runDir, 'targets.txt')

  if (step.kind === 'internal') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [],
      cwd: projectPath(cwd),
      outputFiles: [],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-http-baseline') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: ['redscope-internal-http-baseline', target.normalizedUrl ?? target.raw],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'baseline-url.json'))],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-artifact-summary') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [
        'redscope-internal-artifact-summary',
        target.artifactPath ? projectPath(target.artifactPath) : target.raw,
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'artifact-summary.json'))],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-poc-candidate-validation') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [
        'redscope-internal-poc-candidate-validation',
        target.normalizedUrl ?? target.raw,
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [
        projectPath(join(outputDir, 'poc-validation-plan.json')),
        projectPath(join(outputDir, 'poc-search-enrichment.json')),
        projectPath(join(outputDir, 'vulnerability-advisory-enrichment.json')),
        projectPath(join(outputDir, 'validation-evidence-gates.json')),
      ],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-low-impact-validator') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [
        'redscope-internal-low-impact-validator',
        target.normalizedUrl ?? target.raw,
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'low-impact-validation.json'))],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-business-logic-validator') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [
        'redscope-internal-business-logic-validator',
        target.normalizedUrl ?? target.raw,
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'business-logic-validation.json'))],
      status: 'planned',
    }
  }

  if (step.kind === 'internal-stateful-business-logic-validator') {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [
        'redscope-internal-stateful-business-logic-validator',
        target.normalizedUrl ?? target.raw,
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'business-logic-validation.json'))],
      status: 'planned',
    }
  }

  if (!step.tool) {
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [],
      cwd: projectPath(cwd),
      outputFiles: [],
      status: 'skipped',
      reason: 'step has no tool id',
    }
  }

  const scannerToolBlockReason = scannerToolBlockReasonForStep(
    scope,
    profile,
    step.tool,
  )
  if (scannerToolBlockReason) {
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [`<not-approved:${step.tool}>`],
      cwd: projectPath(cwd),
      outputFiles: [],
      status: 'skipped',
      reason: scannerToolBlockReason,
    }
  }

  const executable = await executableForTool(step.tool)
  if (!executable) {
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [`<missing:${step.tool}>`],
      cwd: projectPath(cwd),
      outputFiles: [],
      status: 'skipped',
      reason: `no installed manifest with executablePath for ${step.tool}`,
    }
  }

  if (step.tool === 'gitleaks') {
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [
        executable,
        'detect',
        '--source',
        target.repositoryPath ?? cwd,
        '--report-format',
        'json',
        '--report-path',
        join(outputDir, 'gitleaks.json'),
        '--redact',
        '--no-banner',
      ],
      cwd: projectPath(cwd),
      outputFiles: [projectPath(join(outputDir, 'gitleaks.json'))],
      status: 'planned',
    }
  }

  if (step.tool === 'semgrep') {
    const configPath = await localSemgrepConfig(options, target.repositoryPath ?? cwd)
    if (!configPath) {
      return {
        stepId: step.id,
        tool: step.tool,
        kind: step.kind,
        argv: [executable, 'scan', '--config', '<local-semgrep-config-required>'],
        cwd: projectPath(cwd),
        outputFiles: [],
        status: 'skipped',
        reason: 'no local semgrep config found; pass --semgrep-config',
      }
    }
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [
        executable,
        'scan',
        '--config',
        configPath,
        '--json',
        '--output',
        join(outputDir, 'semgrep.json'),
        '--metrics',
        'off',
        target.repositoryPath ?? cwd,
      ],
      cwd: projectPath(cwd),
      outputFiles: [projectPath(join(outputDir, 'semgrep.json'))],
      status: 'planned',
    }
  }

  if (step.tool === 'httpx') {
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [
        executable,
        '-l',
        targetsFile,
        '-json',
        '-o',
        join(outputDir, 'httpx.jsonl'),
        '-rl',
        String(Math.max(1, limits.requestsPerSecond)),
        '-c',
        String(limits.concurrency),
        '-silent',
        '-no-color',
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'httpx.jsonl'))],
      status: 'planned',
    }
  }

  if (step.tool === 'nuclei') {
    return {
      stepId: step.id,
      tool: step.tool,
      kind: step.kind,
      argv: [
        executable,
        '-l',
        targetsFile,
        '-severity',
        'info,low',
        '-jsonl',
        '-o',
        join(outputDir, 'nuclei-low.jsonl'),
        '-rl',
        String(Math.max(1, limits.requestsPerSecond)),
        '-c',
        String(limits.concurrency),
        '-silent',
        '-no-color',
      ],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(join(outputDir, 'nuclei-low.jsonl'))],
      status: 'planned',
    }
  }

  return {
    stepId: step.id,
    tool: step.tool,
    kind: step.kind,
    argv: [executable],
    cwd: projectPath(cwd),
    outputFiles: [],
    status: 'skipped',
    reason: `tool ${step.tool} is not wired into this runner`,
  }
}

async function buildCommands(
  profile: RunProfile,
  target: TargetPlan,
  runDir: string,
  limits: ReturnType<typeof effectiveRateLimits>,
  options: Options,
  scope: ScopeFile,
): Promise<PlannedCommand[]> {
  const commands: PlannedCommand[] = []
  for (const step of profile.steps) {
    commands.push(
      await plannedCommandForStep(
        step,
        profile,
        target,
        runDir,
        limits,
        options,
        scope,
      ),
    )
  }
  return commands
}

const artifactFileLimit = 50
const artifactScanBytesLimit = 1024 * 1024
const artifactHashBytesLimit = 20 * 1024 * 1024
const artifactCsvRowLimit = 5000
const artifactJsonEventLimit = 5000
const artifactZipEntryLimit = 5000
const artifactZipDirectoryBytesLimit = 4 * 1024 * 1024
const artifactZipTailSearchBytes = 128 * 1024

type ArtifactIndicatorSummary = {
  counts: Record<string, number>
  samples: Record<string, string[]>
}

type ArtifactTimestampSummary = {
  count: number
  first?: string
  last?: string
}

type ArtifactCollection = {
  files: string[]
  truncated: boolean
}

type ArtifactStructuredSummary = {
  formats: string[]
  parsers: string[]
  warnings: string[]
  csv?: ArtifactCsvSummary
  jsonEvents?: ArtifactJsonEventSummary
  stix?: ArtifactStixSummary
  taxii?: ArtifactTaxiiSummary
  zip?: ArtifactZipSummary
  evtx?: ArtifactEvtxSummary
  pcap?: ArtifactPcapSummary
  pe?: ArtifactPeSummary
  registryHive?: ArtifactRegistryHiveSummary
  mailHeaders?: ArtifactMailHeaderSummary
  caseManifest?: ArtifactCaseManifestSummary
}

type ArtifactCsvSummary = {
  rowCount: number
  columnCount: number
  detectedColumns: Record<string, string[]>
  severityCounts: Record<string, number>
  eventTypeCounts: Record<string, number>
  productCounts: Record<string, number>
  truncated: boolean
}

type ArtifactJsonEventSummary = {
  eventCount: number
  fieldCounts: Record<string, number>
  timestampFieldCounts: Record<string, number>
  severityCounts: Record<string, number>
  eventTypeCounts: Record<string, number>
  truncated: boolean
}

type ArtifactStixSummary = {
  bundleCount: number
  objectCount: number
  objectTypeCounts: Record<string, number>
  indicatorCount: number
  relationshipCount: number
  patternTypeCounts: Record<string, number>
}

type ArtifactTaxiiSummary = {
  apiRootCount: number
  collectionCount: number
  mediaTypeCounts: Record<string, number>
  hasMore: boolean
}

type ArtifactZipSummary = {
  entryCount: number
  extensionCounts: Record<string, number>
  declaredCompressedBytes: number
  declaredUncompressedBytes: number
  encryptedEntryCount: number
  pathTraversalEntryCount: number
  truncated: boolean
  warnings: string[]
}

type ArtifactEvtxSummary = {
  formatDetected: boolean
  bytes: number
  majorVersion?: number
  minorVersion?: number
  headerSize?: number
  headerBlockSize?: number
  firstChunkNumber?: string
  lastChunkNumber?: string
  nextRecordIdentifier?: string
  declaredChunkCount?: number
  detectedChunkHeaderCount: number
  chunkHeaderSampleCount: number
  chunkRecordNumberFirst?: string
  chunkRecordNumberLast?: string
  chunkRecordIdentifierFirst?: string
  chunkRecordIdentifierLast?: string
  eventRecordSampleCount: number
  eventRecordTimestampCount: number
  eventRecordBodyBytes: number
  eventRecordSizeMin?: number
  eventRecordSizeMax?: number
  eventRecordIdentifierFirst?: string
  eventRecordIdentifierLast?: string
  eventRecordTimeFirst?: string
  eventRecordTimeLast?: string
  eventRecordSizeMismatchCount: number
  eventRecordTruncatedCount: number
  chunkWithEventRecordsCount: number
  eventRecordScanTruncated: boolean
  binXmlTokenCounts: Record<string, number>
  binXmlTemplateInstanceCount: number
  binXmlNormalSubstitutionCount: number
  binXmlOptionalSubstitutionCount: number
  binXmlFragmentHeaderCount: number
  binXmlScanBytes: number
  binXmlScanTruncated: boolean
  templateIdentifierDigests: string[]
  notes: string[]
  warnings: string[]
}

type ArtifactPcapSummary = {
  format: 'pcap' | 'pcapng'
  bytes: number
  endianness?: 'little' | 'big'
  timestampResolution?: 'microsecond' | 'nanosecond'
  majorVersion?: number
  minorVersion?: number
  snapLength?: number
  linkType?: number
  packetHeaderSampleCount: number
  flow?: ArtifactPcapFlowSummary
  pcapng?: ArtifactPcapNgSummary
  truncated: boolean
  warnings: string[]
}

type ArtifactPcapFlowSummary = {
  parsedPacketCount: number
  totalCapturedBytes: number
  totalOriginalBytes: number
  firstPacketTime?: string
  lastPacketTime?: string
  etherTypeCounts: Record<string, number>
  networkProtocolCounts: Record<string, number>
  transportProtocolCounts: Record<string, number>
  portCounts: Record<string, number>
  tcpFlagCounts: Record<string, number>
  flowHashSamples: string[]
}

type ArtifactPcapNgSummary = {
  sectionCount: number
  interfaceCount: number
  enhancedPacketBlockCount: number
  simplePacketBlockCount: number
  packetBlockCount: number
  nameResolutionBlockCount: number
  interfaceStatisticsBlockCount: number
  blockTypeCounts: Record<string, number>
  optionCounts: Record<string, number>
  interfaceLinkTypeCounts: Record<string, number>
  interfaceSnapLengthCounts: Record<string, number>
  timestampResolutionCounts: Record<string, number>
  unknownBlockTypeSamples: string[]
}

type ArtifactPeSummary = {
  formatDetected: boolean
  bytes: number
  machine?: string
  machineName?: string
  timestamp?: string
  characteristicCounts: Record<string, number>
  optionalHeaderMagic?: string
  subsystem?: string
  subsystemName?: string
  dllCharacteristicCounts: Record<string, number>
  imageBase?: string
  entryPointRva?: number
  sizeOfImage?: number
  sizeOfHeaders?: number
  sectionCount: number
  executableSectionCount: number
  writableSectionCount: number
  readableSectionCount: number
  sectionCharacteristicCounts: Record<string, number>
  sectionNameDigests: string[]
  importDirectoryRva?: number
  importDirectorySize?: number
  certificateTableSize?: number
  notes: string[]
  warnings: string[]
}

type ArtifactRegistryHiveSummary = {
  formatDetected: boolean
  bytes: number
  primarySequence?: number
  secondarySequence?: number
  sequenceMismatch: boolean
  lastWritten?: string
  majorVersion?: number
  minorVersion?: number
  type?: number
  format?: number
  rootCellOffset?: number
  hiveBinsDataSize?: number
  clusteringFactor?: number
  embeddedFileNameDigest?: string
  hbinHeaderCount: number
  hbinSizeBytes: number
  firstHbinOffset?: number
  lastHbinOffset?: number
  hbinScanTruncated: boolean
  notes: string[]
  warnings: string[]
}

type ArtifactMailHeaderSummary = {
  messageCount: number
  headerCounts: Record<string, number>
  fromDomainCounts: Record<string, number>
  recipientDomainCounts: Record<string, number>
  receivedHopCounts: Record<string, number>
  authenticationResultCount: number
  attachmentPartCount: number
  attachmentNameCount: number
  inlineAttachmentCount: number
  attachmentContentTypeCounts: Record<string, number>
  attachmentExtensionCounts: Record<string, number>
  attachmentDispositionCounts: Record<string, number>
  warnings: string[]
}

type ArtifactCaseManifestSummary = {
  declaredArtifactCount: number
  evidenceTypeCounts: Record<string, number>
  hasChainOfCustody: boolean
  hasScopeReference: boolean
  hasOwnerReference: boolean
  hasTimelineReference: boolean
  evidenceWithStableIdCount: number
  evidenceWithPathCount: number
  evidenceWithHashCount: number
  evidenceWithTimestampCount: number
  evidenceWithSourceCount: number
  evidenceWithCustodianCount: number
  duplicateEvidenceIdCount: number
  pathTraversalReferenceCount: number
  absolutePathReferenceCount: number
  validationWarnings: string[]
}

type ArtifactStructuredAggregate = {
  formatCounts: Record<string, number>
  parserCounts: Record<string, number>
  csv: {
    fileCount: number
    rowCount: number
    severityCounts: Record<string, number>
    eventTypeCounts: Record<string, number>
    productCounts: Record<string, number>
    detectedColumnCounts: Record<string, number>
    truncatedFileCount: number
  }
  jsonEvents: {
    fileCount: number
    eventCount: number
    fieldCounts: Record<string, number>
    timestampFieldCounts: Record<string, number>
    severityCounts: Record<string, number>
    eventTypeCounts: Record<string, number>
    truncatedFileCount: number
  }
  stix: {
    bundleCount: number
    objectCount: number
    objectTypeCounts: Record<string, number>
    indicatorCount: number
    relationshipCount: number
    patternTypeCounts: Record<string, number>
  }
  taxii: {
    fileCount: number
    apiRootCount: number
    collectionCount: number
    mediaTypeCounts: Record<string, number>
    hasMoreCount: number
  }
  zip: {
    fileCount: number
    entryCount: number
    extensionCounts: Record<string, number>
    declaredCompressedBytes: number
    declaredUncompressedBytes: number
    encryptedEntryCount: number
    pathTraversalEntryCount: number
    truncatedFileCount: number
  }
  evtx: {
    fileCount: number
    totalBytes: number
    detectedFormatCount: number
    declaredChunkCount: number
    detectedChunkHeaderCount: number
    chunkHeaderSampleCount: number
    versionCounts: Record<string, number>
    eventRecordSampleCount: number
    eventRecordTimestampCount: number
    eventRecordBodyBytes: number
    eventRecordSizeMin?: number
    eventRecordSizeMax?: number
    eventRecordIdentifierFirst?: string
    eventRecordIdentifierLast?: string
    eventRecordTimeFirst?: string
    eventRecordTimeLast?: string
    eventRecordSizeMismatchCount: number
    eventRecordTruncatedCount: number
    chunkWithEventRecordsCount: number
    eventRecordScanTruncatedFileCount: number
    binXmlTokenCounts: Record<string, number>
    binXmlTemplateInstanceCount: number
    binXmlNormalSubstitutionCount: number
    binXmlOptionalSubstitutionCount: number
    binXmlFragmentHeaderCount: number
    binXmlScanBytes: number
    binXmlScanTruncatedFileCount: number
    templateIdentifierDigestSamples: string[]
  }
  pcap: {
    fileCount: number
    totalBytes: number
    packetHeaderSampleCount: number
    parsedPacketCount: number
    totalCapturedBytes: number
    totalOriginalBytes: number
    firstPacketTime?: string
    lastPacketTime?: string
    formatCounts: Record<string, number>
    linkTypeCounts: Record<string, number>
    etherTypeCounts: Record<string, number>
    networkProtocolCounts: Record<string, number>
    transportProtocolCounts: Record<string, number>
    portCounts: Record<string, number>
    tcpFlagCounts: Record<string, number>
    flowHashSamples: string[]
    pcapngSectionCount: number
    pcapngInterfaceCount: number
    pcapngEnhancedPacketBlockCount: number
    pcapngSimplePacketBlockCount: number
    pcapngPacketBlockCount: number
    pcapngNameResolutionBlockCount: number
    pcapngInterfaceStatisticsBlockCount: number
    pcapngBlockTypeCounts: Record<string, number>
    pcapngOptionCounts: Record<string, number>
    pcapngInterfaceLinkTypeCounts: Record<string, number>
    pcapngTimestampResolutionCounts: Record<string, number>
    pcapngUnknownBlockTypeSamples: string[]
    truncatedFileCount: number
  }
  pe: {
    fileCount: number
    totalBytes: number
    machineCounts: Record<string, number>
    subsystemCounts: Record<string, number>
    optionalHeaderMagicCounts: Record<string, number>
    characteristicCounts: Record<string, number>
    dllCharacteristicCounts: Record<string, number>
    sectionCharacteristicCounts: Record<string, number>
    sectionCount: number
    executableSectionCount: number
    writableSectionCount: number
    readableSectionCount: number
    importDirectoryCount: number
    certificateTableCount: number
    timestampFirst?: string
    timestampLast?: string
    warningCounts: Record<string, number>
  }
  registryHive: {
    fileCount: number
    totalBytes: number
    versionCounts: Record<string, number>
    typeCounts: Record<string, number>
    formatCounts: Record<string, number>
    sequenceMismatchCount: number
    hbinHeaderCount: number
    hbinSizeBytes: number
    hbinScanTruncatedFileCount: number
    lastWrittenFirst?: string
    lastWrittenLast?: string
    warningCounts: Record<string, number>
  }
  mailHeaders: {
    fileCount: number
    messageCount: number
    headerCounts: Record<string, number>
    fromDomainCounts: Record<string, number>
    recipientDomainCounts: Record<string, number>
    receivedHopCounts: Record<string, number>
    authenticationResultCount: number
    attachmentPartCount: number
    attachmentNameCount: number
    inlineAttachmentCount: number
    attachmentContentTypeCounts: Record<string, number>
    attachmentExtensionCounts: Record<string, number>
    attachmentDispositionCounts: Record<string, number>
  }
  caseManifests: {
    fileCount: number
    declaredArtifactCount: number
    evidenceTypeCounts: Record<string, number>
    chainOfCustodyCount: number
    scopeReferenceCount: number
    ownerReferenceCount: number
    timelineReferenceCount: number
    evidenceWithStableIdCount: number
    evidenceWithPathCount: number
    evidenceWithHashCount: number
    evidenceWithTimestampCount: number
    evidenceWithSourceCount: number
    evidenceWithCustodianCount: number
    duplicateEvidenceIdCount: number
    pathTraversalReferenceCount: number
    absolutePathReferenceCount: number
    validationWarningCounts: Record<string, number>
  }
  warnings: string[]
}

function isTextArtifact(path: string): boolean {
  return [
    '.csv',
    '.eml',
    '.json',
    '.jsonl',
    '.log',
    '.mail',
    '.mime',
    '.md',
    '.ndjson',
    '.stix',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
  ].includes(extname(path).toLowerCase())
}

async function collectArtifactFiles(root: string): Promise<ArtifactCollection> {
  const files: string[] = []
  let truncated = false

  async function walk(path: string) {
    if (files.length >= artifactFileLimit) {
      truncated = true
      return
    }

    const info = await stat(path)
    if (info.isFile()) {
      files.push(path)
      return
    }
    if (!info.isDirectory()) return

    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= artifactFileLimit) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      if (['.git', 'node_modules', 'outputs', 'memory'].includes(entry.name)) {
        continue
      }
      await walk(join(path, entry.name))
    }
  }

  await walk(root)
  return { files, truncated }
}

async function sha256SmallFile(path: string, bytes: number): Promise<string | null> {
  if (bytes > artifactHashBytesLimit) return null
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

function emptyIndicatorSummary(): ArtifactIndicatorSummary {
  return { counts: {}, samples: {} }
}

function addIndicator(
  summary: ArtifactIndicatorSummary,
  type: string,
  value: string,
) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return
  const samples = summary.samples[type] ?? []
  if (!samples.includes(normalized) && samples.length < 25) {
    samples.push(normalized)
  }
  summary.samples[type] = samples
  summary.counts[type] = (summary.counts[type] ?? 0) + 1
}

function collectIndicators(content: string): ArtifactIndicatorSummary {
  const summary = emptyIndicatorSummary()
  const patterns: Array<[string, RegExp]> = [
    ['url', /\bhttps?:\/\/[^\s"'<>]+/gi],
    ['ipv4', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ['sha256', /\b[a-f0-9]{64}\b/gi],
    ['sha1', /\b[a-f0-9]{40}\b/gi],
    ['md5', /\b[a-f0-9]{32}\b/gi],
    ['domain', /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi],
  ]

  for (const [type, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[0]) addIndicator(summary, type, match[0])
    }
  }
  return summary
}

function collectTimestamps(content: string): ArtifactTimestampSummary {
  const dates: string[] = []
  const pattern = /\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-Z]{5,}\b/g
  for (const match of content.matchAll(pattern)) {
    const value = match[0]
    const time = Date.parse(value)
    if (Number.isFinite(time)) dates.push(new Date(time).toISOString())
  }
  dates.sort()
  return {
    count: dates.length,
    first: dates[0],
    last: dates[dates.length - 1],
  }
}

function collectKeywordHits(content: string): Record<string, number> {
  const patterns: Array<[string, RegExp]> = [
    ['authentication_failure', /failed password|authentication failed|invalid login|login failed/gi],
    ['access_denied', /access denied|forbidden|unauthorized|permission denied/gi],
    ['malware_signal', /malware|ransom|trojan|beacon|command and control|\bc2\b/gi],
    ['exfiltration_signal', /exfil|large upload|data transfer|staged archive/gi],
    ['privilege_change', /sudo|privilege|administrator|root login|role changed/gi],
  ]
  const hits: Record<string, number> = {}
  for (const [name, pattern] of patterns) {
    const count = content.match(pattern)?.length ?? 0
    if (count > 0) hits[name] = count
  }
  return hits
}

function mergeCounts(
  target: Record<string, number>,
  source: Record<string, number>,
) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value
  }
}

function mergeSamples(
  target: Record<string, string[]>,
  source: Record<string, string[]>,
) {
  for (const [key, values] of Object.entries(source)) {
    const current = target[key] ?? []
    for (const value of values) {
      if (!current.includes(value) && current.length < 25) current.push(value)
    }
    target[key] = current
  }
}

function addCount(
  target: Record<string, number>,
  key: string | undefined,
  amount = 1,
) {
  const normalized = key?.trim().toLowerCase()
  if (!normalized) return
  target[normalized] = (target[normalized] ?? 0) + amount
}

function pushUnique(target: string[], value: string | undefined) {
  const normalized = value?.trim()
  if (!normalized || target.includes(normalized)) return
  target.push(normalized)
}

function compareDecimalString(a: string, b: string): number {
  const left = a.replace(/^0+/, '') || '0'
  const right = b.replace(/^0+/, '') || '0'
  if (left.length !== right.length) return left.length - right.length
  return left.localeCompare(right)
}

function minDecimalString(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (candidate == null) return current
  if (current == null) return candidate
  return compareDecimalString(candidate, current) < 0 ? candidate : current
}

function maxDecimalString(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (candidate == null) return current
  if (current == null) return candidate
  return compareDecimalString(candidate, current) > 0 ? candidate : current
}

function safeCategoryValue(value: unknown): string | undefined {
  if (value == null) return undefined
  const raw = String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim()
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return '[url-value]'
  if (/\b[a-f0-9]{32,64}\b/i.test(raw)) return '[hash-value]'
  if (raw.length > 80) return '[long-value]'
  if ((raw.includes('\\') || raw.includes('/')) && raw.length > 30) {
    return '[path-like-value]'
  }
  return raw.toLowerCase()
}

function addCategoricalCount(
  target: Record<string, number>,
  value: unknown,
  maxKeys = 100,
) {
  const normalized = safeCategoryValue(value)
  if (!normalized) return
  if (!Object.hasOwn(target, normalized) && Object.keys(target).length >= maxKeys) {
    addCount(target, '[other]')
    return
  }
  addCount(target, normalized)
}

async function readFileRange(
  path: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readFilePrefix(path: string, length: number): Promise<Buffer> {
  return readFileRange(path, 0, length)
}

function emptyStructuredSummary(): ArtifactStructuredSummary {
  return { formats: [], parsers: [], warnings: [] }
}

function emptyStructuredAggregate(): ArtifactStructuredAggregate {
  return {
    formatCounts: {},
    parserCounts: {},
    csv: {
      fileCount: 0,
      rowCount: 0,
      severityCounts: {},
      eventTypeCounts: {},
      productCounts: {},
      detectedColumnCounts: {},
      truncatedFileCount: 0,
    },
    jsonEvents: {
      fileCount: 0,
      eventCount: 0,
      fieldCounts: {},
      timestampFieldCounts: {},
      severityCounts: {},
      eventTypeCounts: {},
      truncatedFileCount: 0,
    },
    stix: {
      bundleCount: 0,
      objectCount: 0,
      objectTypeCounts: {},
      indicatorCount: 0,
      relationshipCount: 0,
      patternTypeCounts: {},
    },
    taxii: {
      fileCount: 0,
      apiRootCount: 0,
      collectionCount: 0,
      mediaTypeCounts: {},
      hasMoreCount: 0,
    },
    zip: {
      fileCount: 0,
      entryCount: 0,
      extensionCounts: {},
      declaredCompressedBytes: 0,
      declaredUncompressedBytes: 0,
      encryptedEntryCount: 0,
      pathTraversalEntryCount: 0,
      truncatedFileCount: 0,
    },
    evtx: {
      fileCount: 0,
      totalBytes: 0,
      detectedFormatCount: 0,
      declaredChunkCount: 0,
      detectedChunkHeaderCount: 0,
      chunkHeaderSampleCount: 0,
      versionCounts: {},
      eventRecordSampleCount: 0,
      eventRecordTimestampCount: 0,
      eventRecordBodyBytes: 0,
      eventRecordSizeMin: undefined,
      eventRecordSizeMax: undefined,
      eventRecordIdentifierFirst: undefined,
      eventRecordIdentifierLast: undefined,
      eventRecordTimeFirst: undefined,
      eventRecordTimeLast: undefined,
      eventRecordSizeMismatchCount: 0,
      eventRecordTruncatedCount: 0,
      chunkWithEventRecordsCount: 0,
      eventRecordScanTruncatedFileCount: 0,
      binXmlTokenCounts: {},
      binXmlTemplateInstanceCount: 0,
      binXmlNormalSubstitutionCount: 0,
      binXmlOptionalSubstitutionCount: 0,
      binXmlFragmentHeaderCount: 0,
      binXmlScanBytes: 0,
      binXmlScanTruncatedFileCount: 0,
      templateIdentifierDigestSamples: [],
    },
    pcap: {
      fileCount: 0,
      totalBytes: 0,
      packetHeaderSampleCount: 0,
      parsedPacketCount: 0,
      totalCapturedBytes: 0,
      totalOriginalBytes: 0,
      firstPacketTime: undefined,
      lastPacketTime: undefined,
      formatCounts: {},
      linkTypeCounts: {},
      etherTypeCounts: {},
      networkProtocolCounts: {},
      transportProtocolCounts: {},
      portCounts: {},
      tcpFlagCounts: {},
      flowHashSamples: [],
      pcapngSectionCount: 0,
      pcapngInterfaceCount: 0,
      pcapngEnhancedPacketBlockCount: 0,
      pcapngSimplePacketBlockCount: 0,
      pcapngPacketBlockCount: 0,
      pcapngNameResolutionBlockCount: 0,
      pcapngInterfaceStatisticsBlockCount: 0,
      pcapngBlockTypeCounts: {},
      pcapngOptionCounts: {},
      pcapngInterfaceLinkTypeCounts: {},
      pcapngTimestampResolutionCounts: {},
      pcapngUnknownBlockTypeSamples: [],
      truncatedFileCount: 0,
    },
    pe: {
      fileCount: 0,
      totalBytes: 0,
      machineCounts: {},
      subsystemCounts: {},
      optionalHeaderMagicCounts: {},
      characteristicCounts: {},
      dllCharacteristicCounts: {},
      sectionCharacteristicCounts: {},
      sectionCount: 0,
      executableSectionCount: 0,
      writableSectionCount: 0,
      readableSectionCount: 0,
      importDirectoryCount: 0,
      certificateTableCount: 0,
      timestampFirst: undefined,
      timestampLast: undefined,
      warningCounts: {},
    },
    registryHive: {
      fileCount: 0,
      totalBytes: 0,
      versionCounts: {},
      typeCounts: {},
      formatCounts: {},
      sequenceMismatchCount: 0,
      hbinHeaderCount: 0,
      hbinSizeBytes: 0,
      hbinScanTruncatedFileCount: 0,
      lastWrittenFirst: undefined,
      lastWrittenLast: undefined,
      warningCounts: {},
    },
    mailHeaders: {
      fileCount: 0,
      messageCount: 0,
      headerCounts: {},
      fromDomainCounts: {},
      recipientDomainCounts: {},
      receivedHopCounts: {},
      authenticationResultCount: 0,
      attachmentPartCount: 0,
      attachmentNameCount: 0,
      inlineAttachmentCount: 0,
      attachmentContentTypeCounts: {},
      attachmentExtensionCounts: {},
      attachmentDispositionCounts: {},
    },
    caseManifests: {
      fileCount: 0,
      declaredArtifactCount: 0,
      evidenceTypeCounts: {},
      chainOfCustodyCount: 0,
      scopeReferenceCount: 0,
      ownerReferenceCount: 0,
      timelineReferenceCount: 0,
      evidenceWithStableIdCount: 0,
      evidenceWithPathCount: 0,
      evidenceWithHashCount: 0,
      evidenceWithTimestampCount: 0,
      evidenceWithSourceCount: 0,
      evidenceWithCustodianCount: 0,
      duplicateEvidenceIdCount: 0,
      pathTraversalReferenceCount: 0,
      absolutePathReferenceCount: 0,
      validationWarningCounts: {},
    },
    warnings: [],
  }
}

function mergeStructuredSummary(
  aggregate: ArtifactStructuredAggregate,
  summary: ArtifactStructuredSummary | undefined,
) {
  if (!summary) return

  for (const format of summary.formats) addCount(aggregate.formatCounts, format)
  for (const parser of summary.parsers) addCount(aggregate.parserCounts, parser)
  for (const warning of summary.warnings) pushUnique(aggregate.warnings, warning)

  if (summary.csv) {
    aggregate.csv.fileCount++
    aggregate.csv.rowCount += summary.csv.rowCount
    mergeCounts(aggregate.csv.severityCounts, summary.csv.severityCounts)
    mergeCounts(aggregate.csv.eventTypeCounts, summary.csv.eventTypeCounts)
    mergeCounts(aggregate.csv.productCounts, summary.csv.productCounts)
    if (summary.csv.truncated) aggregate.csv.truncatedFileCount++
    for (const [group, columns] of Object.entries(summary.csv.detectedColumns)) {
      if (columns.length > 0) addCount(aggregate.csv.detectedColumnCounts, group)
    }
  }

  if (summary.jsonEvents) {
    aggregate.jsonEvents.fileCount++
    aggregate.jsonEvents.eventCount += summary.jsonEvents.eventCount
    mergeCounts(aggregate.jsonEvents.fieldCounts, summary.jsonEvents.fieldCounts)
    mergeCounts(
      aggregate.jsonEvents.timestampFieldCounts,
      summary.jsonEvents.timestampFieldCounts,
    )
    mergeCounts(aggregate.jsonEvents.severityCounts, summary.jsonEvents.severityCounts)
    mergeCounts(
      aggregate.jsonEvents.eventTypeCounts,
      summary.jsonEvents.eventTypeCounts,
    )
    if (summary.jsonEvents.truncated) aggregate.jsonEvents.truncatedFileCount++
  }

  if (summary.stix) {
    aggregate.stix.bundleCount += summary.stix.bundleCount
    aggregate.stix.objectCount += summary.stix.objectCount
    mergeCounts(aggregate.stix.objectTypeCounts, summary.stix.objectTypeCounts)
    aggregate.stix.indicatorCount += summary.stix.indicatorCount
    aggregate.stix.relationshipCount += summary.stix.relationshipCount
    mergeCounts(aggregate.stix.patternTypeCounts, summary.stix.patternTypeCounts)
  }

  if (summary.taxii) {
    aggregate.taxii.fileCount++
    aggregate.taxii.apiRootCount += summary.taxii.apiRootCount
    aggregate.taxii.collectionCount += summary.taxii.collectionCount
    mergeCounts(aggregate.taxii.mediaTypeCounts, summary.taxii.mediaTypeCounts)
    if (summary.taxii.hasMore) aggregate.taxii.hasMoreCount++
  }

  if (summary.zip) {
    aggregate.zip.fileCount++
    aggregate.zip.entryCount += summary.zip.entryCount
    aggregate.zip.declaredCompressedBytes += summary.zip.declaredCompressedBytes
    aggregate.zip.declaredUncompressedBytes += summary.zip.declaredUncompressedBytes
    aggregate.zip.encryptedEntryCount += summary.zip.encryptedEntryCount
    aggregate.zip.pathTraversalEntryCount += summary.zip.pathTraversalEntryCount
    mergeCounts(aggregate.zip.extensionCounts, summary.zip.extensionCounts)
    if (summary.zip.truncated) aggregate.zip.truncatedFileCount++
    for (const warning of summary.zip.warnings) {
      pushUnique(aggregate.warnings, warning)
    }
  }

  if (summary.evtx) {
    aggregate.evtx.fileCount++
    aggregate.evtx.totalBytes += summary.evtx.bytes
    if (summary.evtx.formatDetected) aggregate.evtx.detectedFormatCount++
    aggregate.evtx.declaredChunkCount += summary.evtx.declaredChunkCount ?? 0
    aggregate.evtx.detectedChunkHeaderCount += summary.evtx.detectedChunkHeaderCount
    aggregate.evtx.chunkHeaderSampleCount += summary.evtx.chunkHeaderSampleCount
    aggregate.evtx.eventRecordSampleCount += summary.evtx.eventRecordSampleCount
    aggregate.evtx.eventRecordTimestampCount += summary.evtx.eventRecordTimestampCount
    aggregate.evtx.eventRecordBodyBytes += summary.evtx.eventRecordBodyBytes
    aggregate.evtx.eventRecordSizeMismatchCount +=
      summary.evtx.eventRecordSizeMismatchCount
    aggregate.evtx.eventRecordTruncatedCount += summary.evtx.eventRecordTruncatedCount
    aggregate.evtx.chunkWithEventRecordsCount += summary.evtx.chunkWithEventRecordsCount
    mergeCounts(aggregate.evtx.binXmlTokenCounts, summary.evtx.binXmlTokenCounts)
    aggregate.evtx.binXmlTemplateInstanceCount +=
      summary.evtx.binXmlTemplateInstanceCount
    aggregate.evtx.binXmlNormalSubstitutionCount +=
      summary.evtx.binXmlNormalSubstitutionCount
    aggregate.evtx.binXmlOptionalSubstitutionCount +=
      summary.evtx.binXmlOptionalSubstitutionCount
    aggregate.evtx.binXmlFragmentHeaderCount += summary.evtx.binXmlFragmentHeaderCount
    aggregate.evtx.binXmlScanBytes += summary.evtx.binXmlScanBytes
    if (summary.evtx.eventRecordScanTruncated) {
      aggregate.evtx.eventRecordScanTruncatedFileCount++
    }
    if (summary.evtx.binXmlScanTruncated) {
      aggregate.evtx.binXmlScanTruncatedFileCount++
    }
    for (const digest of summary.evtx.templateIdentifierDigests) {
      if (
        !aggregate.evtx.templateIdentifierDigestSamples.includes(digest) &&
        aggregate.evtx.templateIdentifierDigestSamples.length < 25
      ) {
        aggregate.evtx.templateIdentifierDigestSamples.push(digest)
      }
    }
    if (summary.evtx.eventRecordSizeMin != null) {
      aggregate.evtx.eventRecordSizeMin =
        aggregate.evtx.eventRecordSizeMin == null
          ? summary.evtx.eventRecordSizeMin
          : Math.min(aggregate.evtx.eventRecordSizeMin, summary.evtx.eventRecordSizeMin)
    }
    if (summary.evtx.eventRecordSizeMax != null) {
      aggregate.evtx.eventRecordSizeMax =
        aggregate.evtx.eventRecordSizeMax == null
          ? summary.evtx.eventRecordSizeMax
          : Math.max(aggregate.evtx.eventRecordSizeMax, summary.evtx.eventRecordSizeMax)
    }
    aggregate.evtx.eventRecordIdentifierFirst = minDecimalString(
      aggregate.evtx.eventRecordIdentifierFirst,
      summary.evtx.eventRecordIdentifierFirst,
    )
    aggregate.evtx.eventRecordIdentifierLast = maxDecimalString(
      aggregate.evtx.eventRecordIdentifierLast,
      summary.evtx.eventRecordIdentifierLast,
    )
    if (summary.evtx.eventRecordTimeFirst) {
      aggregate.evtx.eventRecordTimeFirst =
        aggregate.evtx.eventRecordTimeFirst == null ||
        summary.evtx.eventRecordTimeFirst < aggregate.evtx.eventRecordTimeFirst
          ? summary.evtx.eventRecordTimeFirst
          : aggregate.evtx.eventRecordTimeFirst
    }
    if (summary.evtx.eventRecordTimeLast) {
      aggregate.evtx.eventRecordTimeLast =
        aggregate.evtx.eventRecordTimeLast == null ||
        summary.evtx.eventRecordTimeLast > aggregate.evtx.eventRecordTimeLast
          ? summary.evtx.eventRecordTimeLast
          : aggregate.evtx.eventRecordTimeLast
    }
    if (summary.evtx.majorVersion != null && summary.evtx.minorVersion != null) {
      addCount(
        aggregate.evtx.versionCounts,
        `${summary.evtx.majorVersion}.${summary.evtx.minorVersion}`,
      )
    }
    for (const warning of summary.evtx.warnings) {
      pushUnique(aggregate.warnings, warning)
    }
  }

  if (summary.pcap) {
    aggregate.pcap.fileCount++
    aggregate.pcap.totalBytes += summary.pcap.bytes
    aggregate.pcap.packetHeaderSampleCount += summary.pcap.packetHeaderSampleCount
    if (summary.pcap.flow) {
      aggregate.pcap.parsedPacketCount += summary.pcap.flow.parsedPacketCount
      aggregate.pcap.totalCapturedBytes += summary.pcap.flow.totalCapturedBytes
      aggregate.pcap.totalOriginalBytes += summary.pcap.flow.totalOriginalBytes
      mergeCounts(aggregate.pcap.etherTypeCounts, summary.pcap.flow.etherTypeCounts)
      mergeCounts(
        aggregate.pcap.networkProtocolCounts,
        summary.pcap.flow.networkProtocolCounts,
      )
      mergeCounts(
        aggregate.pcap.transportProtocolCounts,
        summary.pcap.flow.transportProtocolCounts,
      )
      mergeCounts(aggregate.pcap.portCounts, summary.pcap.flow.portCounts)
      mergeCounts(aggregate.pcap.tcpFlagCounts, summary.pcap.flow.tcpFlagCounts)
      for (const sample of summary.pcap.flow.flowHashSamples) {
        if (
          !aggregate.pcap.flowHashSamples.includes(sample) &&
          aggregate.pcap.flowHashSamples.length < 25
        ) {
          aggregate.pcap.flowHashSamples.push(sample)
        }
      }
      if (summary.pcap.flow.firstPacketTime) {
        aggregate.pcap.firstPacketTime =
          aggregate.pcap.firstPacketTime == null ||
          summary.pcap.flow.firstPacketTime < aggregate.pcap.firstPacketTime
            ? summary.pcap.flow.firstPacketTime
            : aggregate.pcap.firstPacketTime
      }
      if (summary.pcap.flow.lastPacketTime) {
        aggregate.pcap.lastPacketTime =
          aggregate.pcap.lastPacketTime == null ||
          summary.pcap.flow.lastPacketTime > aggregate.pcap.lastPacketTime
            ? summary.pcap.flow.lastPacketTime
            : aggregate.pcap.lastPacketTime
      }
    }
    addCount(aggregate.pcap.formatCounts, summary.pcap.format)
    if (summary.pcap.linkType != null) {
      addCount(aggregate.pcap.linkTypeCounts, String(summary.pcap.linkType))
    }
    if (summary.pcap.pcapng) {
      const pcapng = summary.pcap.pcapng
      aggregate.pcap.pcapngSectionCount += pcapng.sectionCount
      aggregate.pcap.pcapngInterfaceCount += pcapng.interfaceCount
      aggregate.pcap.pcapngEnhancedPacketBlockCount +=
        pcapng.enhancedPacketBlockCount
      aggregate.pcap.pcapngSimplePacketBlockCount += pcapng.simplePacketBlockCount
      aggregate.pcap.pcapngPacketBlockCount += pcapng.packetBlockCount
      aggregate.pcap.pcapngNameResolutionBlockCount +=
        pcapng.nameResolutionBlockCount
      aggregate.pcap.pcapngInterfaceStatisticsBlockCount +=
        pcapng.interfaceStatisticsBlockCount
      mergeCounts(aggregate.pcap.pcapngBlockTypeCounts, pcapng.blockTypeCounts)
      mergeCounts(aggregate.pcap.pcapngOptionCounts, pcapng.optionCounts)
      mergeCounts(
        aggregate.pcap.pcapngInterfaceLinkTypeCounts,
        pcapng.interfaceLinkTypeCounts,
      )
      mergeCounts(aggregate.pcap.linkTypeCounts, pcapng.interfaceLinkTypeCounts)
      mergeCounts(
        aggregate.pcap.pcapngTimestampResolutionCounts,
        pcapng.timestampResolutionCounts,
      )
      for (const sample of pcapng.unknownBlockTypeSamples) {
        if (
          !aggregate.pcap.pcapngUnknownBlockTypeSamples.includes(sample) &&
          aggregate.pcap.pcapngUnknownBlockTypeSamples.length < 25
        ) {
          aggregate.pcap.pcapngUnknownBlockTypeSamples.push(sample)
        }
      }
    }
    if (summary.pcap.truncated) aggregate.pcap.truncatedFileCount++
    for (const warning of summary.pcap.warnings) {
      pushUnique(aggregate.warnings, warning)
    }
  }

  if (summary.pe) {
    aggregate.pe.fileCount++
    aggregate.pe.totalBytes += summary.pe.bytes
    if (summary.pe.machineName) addCount(aggregate.pe.machineCounts, summary.pe.machineName)
    if (summary.pe.subsystemName) {
      addCount(aggregate.pe.subsystemCounts, summary.pe.subsystemName)
    }
    if (summary.pe.optionalHeaderMagic) {
      addCount(
        aggregate.pe.optionalHeaderMagicCounts,
        summary.pe.optionalHeaderMagic,
      )
    }
    mergeCounts(aggregate.pe.characteristicCounts, summary.pe.characteristicCounts)
    mergeCounts(
      aggregate.pe.dllCharacteristicCounts,
      summary.pe.dllCharacteristicCounts,
    )
    mergeCounts(
      aggregate.pe.sectionCharacteristicCounts,
      summary.pe.sectionCharacteristicCounts,
    )
    aggregate.pe.sectionCount += summary.pe.sectionCount
    aggregate.pe.executableSectionCount += summary.pe.executableSectionCount
    aggregate.pe.writableSectionCount += summary.pe.writableSectionCount
    aggregate.pe.readableSectionCount += summary.pe.readableSectionCount
    if (summary.pe.importDirectorySize || summary.pe.importDirectoryRva) {
      aggregate.pe.importDirectoryCount++
    }
    if (summary.pe.certificateTableSize) aggregate.pe.certificateTableCount++
    if (summary.pe.timestamp) {
      aggregate.pe.timestampFirst =
        aggregate.pe.timestampFirst == null ||
        summary.pe.timestamp < aggregate.pe.timestampFirst
          ? summary.pe.timestamp
          : aggregate.pe.timestampFirst
      aggregate.pe.timestampLast =
        aggregate.pe.timestampLast == null ||
        summary.pe.timestamp > aggregate.pe.timestampLast
          ? summary.pe.timestamp
          : aggregate.pe.timestampLast
    }
    for (const warning of summary.pe.warnings) {
      addCount(aggregate.pe.warningCounts, warning)
      pushUnique(aggregate.warnings, `PE metadata: ${warning}`)
    }
  }

  if (summary.registryHive) {
    aggregate.registryHive.fileCount++
    aggregate.registryHive.totalBytes += summary.registryHive.bytes
    if (
      summary.registryHive.majorVersion != null &&
      summary.registryHive.minorVersion != null
    ) {
      addCount(
        aggregate.registryHive.versionCounts,
        `${summary.registryHive.majorVersion}.${summary.registryHive.minorVersion}`,
      )
    }
    if (summary.registryHive.type != null) {
      addCount(aggregate.registryHive.typeCounts, String(summary.registryHive.type))
    }
    if (summary.registryHive.format != null) {
      addCount(
        aggregate.registryHive.formatCounts,
        String(summary.registryHive.format),
      )
    }
    if (summary.registryHive.sequenceMismatch) {
      aggregate.registryHive.sequenceMismatchCount++
    }
    aggregate.registryHive.hbinHeaderCount += summary.registryHive.hbinHeaderCount
    aggregate.registryHive.hbinSizeBytes += summary.registryHive.hbinSizeBytes
    if (summary.registryHive.hbinScanTruncated) {
      aggregate.registryHive.hbinScanTruncatedFileCount++
    }
    if (summary.registryHive.lastWritten) {
      aggregate.registryHive.lastWrittenFirst =
        aggregate.registryHive.lastWrittenFirst == null ||
        summary.registryHive.lastWritten < aggregate.registryHive.lastWrittenFirst
          ? summary.registryHive.lastWritten
          : aggregate.registryHive.lastWrittenFirst
      aggregate.registryHive.lastWrittenLast =
        aggregate.registryHive.lastWrittenLast == null ||
        summary.registryHive.lastWritten > aggregate.registryHive.lastWrittenLast
          ? summary.registryHive.lastWritten
          : aggregate.registryHive.lastWrittenLast
    }
    for (const warning of summary.registryHive.warnings) {
      addCount(aggregate.registryHive.warningCounts, warning)
      pushUnique(aggregate.warnings, `registry hive metadata: ${warning}`)
    }
  }

  if (summary.mailHeaders) {
    aggregate.mailHeaders.fileCount++
    aggregate.mailHeaders.messageCount += summary.mailHeaders.messageCount
    mergeCounts(aggregate.mailHeaders.headerCounts, summary.mailHeaders.headerCounts)
    mergeCounts(
      aggregate.mailHeaders.fromDomainCounts,
      summary.mailHeaders.fromDomainCounts,
    )
    mergeCounts(
      aggregate.mailHeaders.recipientDomainCounts,
      summary.mailHeaders.recipientDomainCounts,
    )
    mergeCounts(
      aggregate.mailHeaders.receivedHopCounts,
      summary.mailHeaders.receivedHopCounts,
    )
    aggregate.mailHeaders.authenticationResultCount +=
      summary.mailHeaders.authenticationResultCount
    aggregate.mailHeaders.attachmentPartCount +=
      summary.mailHeaders.attachmentPartCount
    aggregate.mailHeaders.attachmentNameCount +=
      summary.mailHeaders.attachmentNameCount
    aggregate.mailHeaders.inlineAttachmentCount +=
      summary.mailHeaders.inlineAttachmentCount
    mergeCounts(
      aggregate.mailHeaders.attachmentContentTypeCounts,
      summary.mailHeaders.attachmentContentTypeCounts,
    )
    mergeCounts(
      aggregate.mailHeaders.attachmentExtensionCounts,
      summary.mailHeaders.attachmentExtensionCounts,
    )
    mergeCounts(
      aggregate.mailHeaders.attachmentDispositionCounts,
      summary.mailHeaders.attachmentDispositionCounts,
    )
    for (const warning of summary.mailHeaders.warnings) {
      pushUnique(aggregate.warnings, warning)
    }
  }

  if (summary.caseManifest) {
    aggregate.caseManifests.fileCount++
    aggregate.caseManifests.declaredArtifactCount +=
      summary.caseManifest.declaredArtifactCount
    mergeCounts(
      aggregate.caseManifests.evidenceTypeCounts,
      summary.caseManifest.evidenceTypeCounts,
    )
    if (summary.caseManifest.hasChainOfCustody) {
      aggregate.caseManifests.chainOfCustodyCount++
    }
    if (summary.caseManifest.hasScopeReference) {
      aggregate.caseManifests.scopeReferenceCount++
    }
    if (summary.caseManifest.hasOwnerReference) {
      aggregate.caseManifests.ownerReferenceCount++
    }
    if (summary.caseManifest.hasTimelineReference) {
      aggregate.caseManifests.timelineReferenceCount++
    }
    aggregate.caseManifests.evidenceWithStableIdCount +=
      summary.caseManifest.evidenceWithStableIdCount
    aggregate.caseManifests.evidenceWithPathCount +=
      summary.caseManifest.evidenceWithPathCount
    aggregate.caseManifests.evidenceWithHashCount +=
      summary.caseManifest.evidenceWithHashCount
    aggregate.caseManifests.evidenceWithTimestampCount +=
      summary.caseManifest.evidenceWithTimestampCount
    aggregate.caseManifests.evidenceWithSourceCount +=
      summary.caseManifest.evidenceWithSourceCount
    aggregate.caseManifests.evidenceWithCustodianCount +=
      summary.caseManifest.evidenceWithCustodianCount
    aggregate.caseManifests.duplicateEvidenceIdCount +=
      summary.caseManifest.duplicateEvidenceIdCount
    aggregate.caseManifests.pathTraversalReferenceCount +=
      summary.caseManifest.pathTraversalReferenceCount
    aggregate.caseManifests.absolutePathReferenceCount +=
      summary.caseManifest.absolutePathReferenceCount
    for (const warning of summary.caseManifest.validationWarnings) {
      addCount(aggregate.caseManifests.validationWarningCounts, warning)
      pushUnique(aggregate.warnings, `case manifest validation: ${warning}`)
    }
  }
}

function parseCsvRows(
  content: string,
  maxRows: number,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let truncated = false

  function pushCell() {
    row.push(cell)
    cell = ''
  }

  function pushRow() {
    pushCell()
    if (row.some(value => value.trim().length > 0)) rows.push(row)
    row = []
    if (rows.length >= maxRows) truncated = true
  }

  for (let index = 0; index < content.length && !truncated; index++) {
    const char = content[index]
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          cell += '"'
          index++
        } else {
          inQuotes = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      pushCell()
    } else if (char === '\n') {
      pushRow()
    } else if (char !== '\r') {
      cell += char
    }
  }

  if (!truncated && (cell.length > 0 || row.length > 0)) pushRow()
  return { rows, truncated }
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9@._-]+/g, '_')
}

function classifiedCsvColumns(headers: string[]): Record<string, string[]> {
  const groups: Record<string, RegExp> = {
    timestamp: /(^|_)(@?timestamp|time|date|event_time|created_at)(_|$)/,
    user: /(^|_)(user|username|account|principal|actor|identity)(_|$)/,
    source: /(^|_)(src|source|client|remote|source_ip|src_ip)(_|$)/,
    destination: /(^|_)(dst|dest|destination|server|host|target)(_|$)/,
    severity: /(^|_)(severity|level|priority|risk|risk_level)(_|$)/,
    eventType: /(^|_)(event|event_type|eventid|action|operation|category)(_|$)/,
    product: /(^|_)(product|vendor|sourcetype|source_type|index)(_|$)/,
  }
  const result: Record<string, string[]> = {}
  for (const [group, pattern] of Object.entries(groups)) {
    result[group] = headers.filter(header => pattern.test(header)).slice(0, 25)
  }
  return result
}

function firstColumnIndex(headers: string[], columns: string[]): number | undefined {
  for (const column of columns) {
    const index = headers.indexOf(column)
    if (index >= 0) return index
  }
  return undefined
}

function summarizeCsvContent(content: string): ArtifactCsvSummary | undefined {
  const parsed = parseCsvRows(content, artifactCsvRowLimit + 1)
  if (parsed.rows.length < 2) return undefined
  const headers = parsed.rows[0].map(normalizedHeader)
  if (headers.length < 2) return undefined

  const rows = parsed.rows.slice(1)
  const detectedColumns = classifiedCsvColumns(headers)
  const severityCounts: Record<string, number> = {}
  const eventTypeCounts: Record<string, number> = {}
  const productCounts: Record<string, number> = {}
  const severityIndex = firstColumnIndex(headers, detectedColumns.severity)
  const eventTypeIndex = firstColumnIndex(headers, detectedColumns.eventType)
  const productIndex = firstColumnIndex(headers, detectedColumns.product)

  for (const row of rows) {
    if (severityIndex != null) {
      addCategoricalCount(severityCounts, row[severityIndex])
    }
    if (eventTypeIndex != null) {
      addCategoricalCount(eventTypeCounts, row[eventTypeIndex])
    }
    if (productIndex != null) {
      addCategoricalCount(productCounts, row[productIndex])
    }
  }

  return {
    rowCount: rows.length,
    columnCount: headers.length,
    detectedColumns,
    severityCounts,
    eventTypeCounts,
    productCounts,
    truncated: parsed.truncated,
  }
}

function collectJsonEvents(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).slice(0, artifactJsonEventLimit)
  }
  if (!isRecord(value)) return []

  for (const key of ['events', 'records', 'logs', 'items', 'results', 'data']) {
    const candidate = value[key]
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord).slice(0, artifactJsonEventLimit)
    }
  }

  return [value]
}

function summarizeJsonEvents(
  events: Record<string, unknown>[],
  truncated: boolean,
): ArtifactJsonEventSummary | undefined {
  if (events.length === 0) return undefined
  const fieldCounts: Record<string, number> = {}
  const timestampFieldCounts: Record<string, number> = {}
  const severityCounts: Record<string, number> = {}
  const eventTypeCounts: Record<string, number> = {}

  for (const event of events) {
    for (const [key, value] of Object.entries(event)) {
      const field = normalizedHeader(key)
      addCount(fieldCounts, field)
      if (/(@?timestamp|time|date|event_time|created_at)/.test(field)) {
        addCount(timestampFieldCounts, field)
      }
      if (/(severity|level|priority|risk)/.test(field)) {
        addCategoricalCount(severityCounts, value)
      }
      if (/(event|event_type|eventid|action|operation|category)/.test(field)) {
        addCategoricalCount(eventTypeCounts, value)
      }
    }
  }

  return {
    eventCount: events.length,
    fieldCounts,
    timestampFieldCounts,
    severityCounts,
    eventTypeCounts,
    truncated,
  }
}

function summarizeStix(value: unknown): ArtifactStixSummary | undefined {
  const objectSets: unknown[][] = []
  if (isRecord(value) && Array.isArray(value.objects)) {
    objectSets.push(value.objects)
  }
  if (Array.isArray(value)) {
    const records = value.filter(isRecord)
    if (records.some(item => typeof item.type === 'string')) objectSets.push(records)
  }
  if (objectSets.length === 0) return undefined

  const summary: ArtifactStixSummary = {
    bundleCount: objectSets.length,
    objectCount: 0,
    objectTypeCounts: {},
    indicatorCount: 0,
    relationshipCount: 0,
    patternTypeCounts: {},
  }

  for (const objects of objectSets) {
    for (const item of objects) {
      if (!isRecord(item)) continue
      const type = typeof item.type === 'string' ? item.type : undefined
      if (!type) continue
      summary.objectCount++
      addCount(summary.objectTypeCounts, type)
      if (type === 'indicator') {
        summary.indicatorCount++
        addCategoricalCount(summary.patternTypeCounts, item.pattern_type)
      }
      if (type === 'relationship') summary.relationshipCount++
    }
  }

  return summary.objectCount > 0 ? summary : undefined
}

function summarizeTaxii(value: unknown): ArtifactTaxiiSummary | undefined {
  if (!isRecord(value)) return undefined
  const collections = Array.isArray(value.collections)
    ? value.collections.filter(isRecord)
    : []
  const apiRoots = Array.isArray(value.api_roots)
    ? value.api_roots
    : Array.isArray(value.apiRoots)
      ? value.apiRoots
      : []
  const hasTaxiiShape =
    collections.length > 0 ||
    apiRoots.length > 0 ||
    typeof value.more === 'boolean' ||
    typeof value.next === 'string'
  if (!hasTaxiiShape) return undefined

  const mediaTypeCounts: Record<string, number> = {}
  for (const collection of collections) {
    const mediaTypes = Array.isArray(collection.media_types)
      ? collection.media_types
      : Array.isArray(collection.mediaTypes)
        ? collection.mediaTypes
        : []
    for (const mediaType of mediaTypes) {
      addCategoricalCount(mediaTypeCounts, mediaType)
    }
  }

  return {
    apiRootCount: apiRoots.length,
    collectionCount: collections.length,
    mediaTypeCounts,
    hasMore: value.more === true || typeof value.next === 'string',
  }
}

function hasCaseManifestValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return value != null
}

function caseField(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (hasCaseManifestValue(record[name])) return record[name]
  }
  return undefined
}

function caseStringField(
  record: Record<string, unknown>,
  names: string[],
): string | undefined {
  const value = caseField(record, names)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isDateLikeValue(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const text = String(value).trim()
  if (!text) return false
  return Number.isFinite(Date.parse(text))
}

function summarizeCaseManifest(
  path: string,
  value: unknown,
): ArtifactCaseManifestSummary | undefined {
  if (!isRecord(value)) return undefined
  const name = basename(path).toLowerCase()
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : []
  const evidence = Array.isArray(value.evidence) ? value.evidence : []
  const evidenceItems = [...artifacts, ...evidence].filter(isRecord)
  const hasManifestName = name.includes('manifest') || name.includes('case')
  const hasCaseShape =
    hasManifestName ||
    artifacts.length > 0 ||
    evidence.length > 0 ||
    value.chainOfCustody != null
  if (!hasCaseShape) return undefined

  const evidenceTypeCounts: Record<string, number> = {}
  const validationWarnings: string[] = []
  let evidenceWithStableIdCount = 0
  let evidenceWithPathCount = 0
  let evidenceWithHashCount = 0
  let evidenceWithTimestampCount = 0
  let evidenceWithSourceCount = 0
  let evidenceWithCustodianCount = 0
  let duplicateEvidenceIdCount = 0
  let pathTraversalReferenceCount = 0
  let absolutePathReferenceCount = 0
  const seenEvidenceIds = new Set<string>()

  for (const item of evidenceItems) {
    const stableId = caseStringField(item, [
      'id',
      'evidenceId',
      'artifactId',
      'caseEvidenceId',
      'uuid',
    ])
    const pathValue = caseStringField(item, [
      'path',
      'file',
      'filepath',
      'filePath',
      'location',
      'uri',
    ])
    const hashValue = caseField(item, [
      'sha256',
      'sha512',
      'sha1',
      'md5',
      'hash',
      'hashes',
    ])
    const typeValue = caseField(item, [
      'type',
      'kind',
      'category',
      'evidenceType',
    ])
    const timestampValue = caseField(item, [
      'acquiredAt',
      'collectedAt',
      'createdAt',
      'timestamp',
      'observedAt',
    ])
    const sourceValue = caseField(item, [
      'source',
      'origin',
      'system',
      'collector',
    ])
    const custodianValue = caseField(item, [
      'custodian',
      'owner',
      'handler',
      'collectedBy',
      'analyst',
    ])

    addCategoricalCount(
      evidenceTypeCounts,
      typeValue,
    )
    if (stableId) {
      evidenceWithStableIdCount++
      const normalizedId = stableId.toLowerCase()
      if (seenEvidenceIds.has(normalizedId)) duplicateEvidenceIdCount++
      seenEvidenceIds.add(normalizedId)
    }
    if (pathValue) {
      evidenceWithPathCount++
      if (/(^|[\\/])\.\.([\\/]|$)/.test(pathValue)) {
        pathTraversalReferenceCount++
      }
      if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(pathValue)) {
        absolutePathReferenceCount++
      }
    }
    if (hasCaseManifestValue(hashValue)) evidenceWithHashCount++
    if (hasCaseManifestValue(timestampValue)) evidenceWithTimestampCount++
    if (hasCaseManifestValue(sourceValue)) evidenceWithSourceCount++
    if (hasCaseManifestValue(custodianValue)) evidenceWithCustodianCount++

    if (!stableId && !pathValue && !hasCaseManifestValue(hashValue)) {
      pushUnique(
        validationWarnings,
        'evidence entries should include at least one stable id, path, or hash',
      )
    }
    if (!hasCaseManifestValue(typeValue)) {
      pushUnique(validationWarnings, 'evidence entries should include evidence type')
    }
    if (!hasCaseManifestValue(timestampValue)) {
      pushUnique(
        validationWarnings,
        'evidence entries should include acquisition timestamp',
      )
    } else if (!isDateLikeValue(timestampValue)) {
      pushUnique(
        validationWarnings,
        'evidence acquisition timestamps should be parseable dates',
      )
    }
    if (!hasCaseManifestValue(sourceValue)) {
      pushUnique(validationWarnings, 'evidence entries should include source metadata')
    }
    if (!hasCaseManifestValue(custodianValue)) {
      pushUnique(
        validationWarnings,
        'evidence entries should include custodian metadata',
      )
    }
  }

  if (!value.caseId && !value.id && !value.name) {
    validationWarnings.push('case manifest should include caseId, id, or name')
  }
  if (artifacts.length + evidence.length === 0) {
    validationWarnings.push('case manifest declares no artifacts or evidence')
  }
  if (value.chainOfCustody == null && value.custody == null) {
    validationWarnings.push('case manifest is missing chain-of-custody metadata')
  }
  if (value.scope == null && value.authorization == null) {
    validationWarnings.push('case manifest is missing scope or authorization reference')
  }
  const hasOwnerReference =
    caseField(value, ['owner', 'analyst', 'lead', 'team', 'reviewer', 'custodian']) !=
    null
  if (!hasOwnerReference) {
    validationWarnings.push('case manifest is missing owner or analyst reference')
  }
  const hasTimelineReference =
    caseField(value, [
      'timeline',
      'timeRange',
      'startedAt',
      'endedAt',
      'incidentStart',
      'incidentEnd',
    ]) != null
  if (!hasTimelineReference) {
    validationWarnings.push('case manifest is missing timeline or time range reference')
  }
  if (duplicateEvidenceIdCount > 0) {
    validationWarnings.push('case manifest contains duplicate evidence identifiers')
  }
  if (pathTraversalReferenceCount > 0) {
    validationWarnings.push('evidence path references should not contain traversal segments')
  }
  if (absolutePathReferenceCount > 0) {
    validationWarnings.push('evidence path references should be bundle-relative')
  }

  return {
    declaredArtifactCount: artifacts.length + evidence.length,
    evidenceTypeCounts,
    hasChainOfCustody: value.chainOfCustody != null || value.custody != null,
    hasScopeReference: value.scope != null || value.authorization != null,
    hasOwnerReference,
    hasTimelineReference,
    evidenceWithStableIdCount,
    evidenceWithPathCount,
    evidenceWithHashCount,
    evidenceWithTimestampCount,
    evidenceWithSourceCount,
    evidenceWithCustodianCount,
    duplicateEvidenceIdCount,
    pathTraversalReferenceCount,
    absolutePathReferenceCount,
    validationWarnings,
  }
}

function summarizeJsonContent(
  path: string,
  content: string,
): ArtifactStructuredSummary | undefined {
  const summary = emptyStructuredSummary()
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    summary.warnings.push(`${projectPath(path)} could not be parsed as JSON`)
    return summary.warnings.length > 0 ? summary : undefined
  }

  const stix = summarizeStix(parsed)
  if (stix) {
    pushUnique(summary.formats, 'stix-json')
    pushUnique(summary.parsers, 'stix')
    summary.stix = stix
  }

  const taxii = summarizeTaxii(parsed)
  if (taxii) {
    pushUnique(summary.formats, 'taxii-json')
    pushUnique(summary.parsers, 'taxii-metadata')
    summary.taxii = taxii
  }

  const caseManifest = summarizeCaseManifest(path, parsed)
  if (caseManifest) {
    pushUnique(summary.formats, 'case-manifest-json')
    pushUnique(summary.parsers, 'case-manifest')
    summary.caseManifest = caseManifest
  }

  if (!stix && !taxii) {
    const events = collectJsonEvents(parsed)
    const truncated =
      Array.isArray(parsed) && parsed.length > artifactJsonEventLimit
    const jsonEvents = summarizeJsonEvents(events, truncated)
    if (jsonEvents && jsonEvents.eventCount > 1) {
      pushUnique(summary.formats, 'json-events')
      pushUnique(summary.parsers, 'json-events')
      summary.jsonEvents = jsonEvents
    }
  }

  return summary.parsers.length > 0 || summary.warnings.length > 0
    ? summary
    : undefined
}

function summarizeJsonLinesContent(
  content: string,
): ArtifactStructuredSummary | undefined {
  const summary = emptyStructuredSummary()
  const events: Record<string, unknown>[] = []
  const lines = content.split(/\r?\n/)
  let parsedLines = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (events.length >= artifactJsonEventLimit) break
    try {
      const parsed = JSON.parse(trimmed)
      parsedLines++
      if (isRecord(parsed)) events.push(parsed)
    } catch {
      summary.warnings.push('JSONL artifact contains unparsable lines')
      break
    }
  }

  const jsonEvents = summarizeJsonEvents(
    events,
    parsedLines > artifactJsonEventLimit,
  )
  if (!jsonEvents) return summary.warnings.length > 0 ? summary : undefined

  pushUnique(summary.formats, 'jsonl-events')
  pushUnique(summary.parsers, 'json-events')
  summary.jsonEvents = jsonEvents
  return summary
}

function zipExtensionForName(name: string): string {
  if (name.endsWith('/') || name.endsWith('\\')) return 'directory'
  return extname(name).toLowerCase() || 'none'
}

function zipNameHasTraversal(name: string): boolean {
  const normalized = name.replace(/\\/g, '/')
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    normalized.split('/').includes('..')
  )
}

function parseZipCentralDirectory(directory: Buffer): ArtifactZipSummary {
  const summary: ArtifactZipSummary = {
    entryCount: 0,
    extensionCounts: {},
    declaredCompressedBytes: 0,
    declaredUncompressedBytes: 0,
    encryptedEntryCount: 0,
    pathTraversalEntryCount: 0,
    truncated: false,
    warnings: [],
  }

  let offset = 0
  while (offset + 46 <= directory.length) {
    if (summary.entryCount >= artifactZipEntryLimit) {
      summary.truncated = true
      break
    }
    if (directory.readUInt32LE(offset) !== 0x02014b50) {
      summary.warnings.push('ZIP central directory parsing stopped early')
      break
    }
    const flags = directory.readUInt16LE(offset + 8)
    const compressedBytes = directory.readUInt32LE(offset + 20)
    const uncompressedBytes = directory.readUInt32LE(offset + 24)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > directory.length) {
      summary.warnings.push('ZIP central directory entry is truncated')
      break
    }

    const name = directory.subarray(nameStart, nameEnd).toString('utf8')
    summary.entryCount++
    addCount(summary.extensionCounts, zipExtensionForName(name))
    summary.declaredCompressedBytes += compressedBytes
    summary.declaredUncompressedBytes += uncompressedBytes
    if ((flags & 0x0001) !== 0) summary.encryptedEntryCount++
    if (zipNameHasTraversal(name)) summary.pathTraversalEntryCount++

    offset = nameEnd + extraLength + commentLength
  }

  return summary
}

async function summarizeZipArtifact(
  path: string,
  bytes: number,
): Promise<ArtifactZipSummary> {
  const tailBytes = Math.min(bytes, artifactZipTailSearchBytes)
  const tail = await readFileRange(path, bytes - tailBytes, tailBytes)
  let eocdOffset = -1
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index
      break
    }
  }

  if (eocdOffset < 0) {
    return {
      entryCount: 0,
      extensionCounts: {},
      declaredCompressedBytes: 0,
      declaredUncompressedBytes: 0,
      encryptedEntryCount: 0,
      pathTraversalEntryCount: 0,
      truncated: false,
      warnings: ['ZIP end-of-central-directory record was not found'],
    }
  }

  const expectedEntries = tail.readUInt16LE(eocdOffset + 10)
  const directoryBytes = tail.readUInt32LE(eocdOffset + 12)
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16)
  const warnings: string[] = []

  if (expectedEntries === 0xffff || directoryBytes === 0xffffffff) {
    warnings.push('ZIP64 metadata is not fully parsed by the local summary')
  }
  if (directoryBytes > artifactZipDirectoryBytesLimit) {
    warnings.push('ZIP central directory exceeds local parser size limit')
    return {
      entryCount: expectedEntries === 0xffff ? 0 : expectedEntries,
      extensionCounts: {},
      declaredCompressedBytes: 0,
      declaredUncompressedBytes: 0,
      encryptedEntryCount: 0,
      pathTraversalEntryCount: 0,
      truncated: true,
      warnings,
    }
  }
  if (directoryOffset + directoryBytes > bytes) {
    warnings.push('ZIP central directory points outside the archive bounds')
    return {
      entryCount: 0,
      extensionCounts: {},
      declaredCompressedBytes: 0,
      declaredUncompressedBytes: 0,
      encryptedEntryCount: 0,
      pathTraversalEntryCount: 0,
      truncated: false,
      warnings,
    }
  }

  const directory = await readFileRange(path, directoryOffset, directoryBytes)
  const summary = parseZipCentralDirectory(directory)
  summary.warnings.push(...warnings)
  if (expectedEntries !== 0xffff && summary.entryCount < expectedEntries) {
    summary.warnings.push('ZIP entry summary is lower than declared entry count')
  }
  return summary
}

const evtxChunkSize = 64 * 1024
const evtxFileHeaderSize = 4096
const evtxChunkHeaderSize = 512
const evtxEventRecordMagic = Buffer.from([0x2a, 0x2a, 0x00, 0x00])
const evtxEventRecordHeaderSize = 24
const evtxEventRecordMinimumSize = 28
const evtxEventRecordSampleLimit = 512
const evtxBinXmlScanBytesLimit = 512 * 1024
const windowsFileTimeUnixEpochOffset = 116444736000000000n

type EvtxEventRecordScan = {
  eventRecordSampleCount: number
  eventRecordTimestampCount: number
  eventRecordBodyBytes: number
  eventRecordSizeMin?: number
  eventRecordSizeMax?: number
  eventRecordIdentifierFirst?: string
  eventRecordIdentifierLast?: string
  eventRecordTimeFirst?: string
  eventRecordTimeLast?: string
  eventRecordSizeMismatchCount: number
  eventRecordTruncatedCount: number
  chunkWithEventRecordsCount: number
  eventRecordScanTruncated: boolean
  binXmlTokenCounts: Record<string, number>
  binXmlTemplateInstanceCount: number
  binXmlNormalSubstitutionCount: number
  binXmlOptionalSubstitutionCount: number
  binXmlFragmentHeaderCount: number
  binXmlScanBytes: number
  binXmlScanTruncated: boolean
  templateIdentifierDigests: string[]
}

function emptyEvtxEventRecordScan(): EvtxEventRecordScan {
  return {
    eventRecordSampleCount: 0,
    eventRecordTimestampCount: 0,
    eventRecordBodyBytes: 0,
    eventRecordSizeMismatchCount: 0,
    eventRecordTruncatedCount: 0,
    chunkWithEventRecordsCount: 0,
    eventRecordScanTruncated: false,
    binXmlTokenCounts: {},
    binXmlTemplateInstanceCount: 0,
    binXmlNormalSubstitutionCount: 0,
    binXmlOptionalSubstitutionCount: 0,
    binXmlFragmentHeaderCount: 0,
    binXmlScanBytes: 0,
    binXmlScanTruncated: false,
    templateIdentifierDigests: [],
  }
}

function windowsFileTimeToIso(fileTime: bigint): string | undefined {
  if (fileTime <= windowsFileTimeUnixEpochOffset) return undefined
  const millis = Number((fileTime - windowsFileTimeUnixEpochOffset) / 10000n)
  if (!Number.isFinite(millis)) return undefined
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function recordEvtxTimestamp(
  scan: EvtxEventRecordScan,
  timestamp: string | undefined,
) {
  if (!timestamp) return
  scan.eventRecordTimestampCount++
  scan.eventRecordTimeFirst =
    scan.eventRecordTimeFirst == null || timestamp < scan.eventRecordTimeFirst
      ? timestamp
      : scan.eventRecordTimeFirst
  scan.eventRecordTimeLast =
    scan.eventRecordTimeLast == null || timestamp > scan.eventRecordTimeLast
      ? timestamp
      : scan.eventRecordTimeLast
}

function recordEvtxEventRecord(
  scan: EvtxEventRecordScan,
  recordSize: number,
  recordIdentifier: string,
  timestamp: string | undefined,
) {
  scan.eventRecordSampleCount++
  scan.eventRecordBodyBytes += Math.max(
    0,
    recordSize - evtxEventRecordHeaderSize - 4,
  )
  scan.eventRecordSizeMin =
    scan.eventRecordSizeMin == null
      ? recordSize
      : Math.min(scan.eventRecordSizeMin, recordSize)
  scan.eventRecordSizeMax =
    scan.eventRecordSizeMax == null
      ? recordSize
      : Math.max(scan.eventRecordSizeMax, recordSize)
  scan.eventRecordIdentifierFirst = minDecimalString(
    scan.eventRecordIdentifierFirst,
    recordIdentifier,
  )
  scan.eventRecordIdentifierLast = maxDecimalString(
    scan.eventRecordIdentifierLast,
    recordIdentifier,
  )
  recordEvtxTimestamp(scan, timestamp)
}

const evtxBinXmlTokenNames: Record<number, string> = {
  0x01: 'open-start-element',
  0x02: 'close-start-element',
  0x03: 'close-empty-element',
  0x04: 'end-element',
  0x05: 'value',
  0x06: 'attribute',
  0x07: 'cdata-section',
  0x08: 'char-ref',
  0x09: 'entity-ref',
  0x0a: 'pi-target',
  0x0b: 'pi-data',
  0x0c: 'template-instance',
  0x0d: 'normal-substitution',
  0x0e: 'optional-substitution',
  0x0f: 'fragment-header',
}

function recordEvtxTemplateDigest(scan: EvtxEventRecordScan, bytes: Buffer) {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (
    !scan.templateIdentifierDigests.includes(digest) &&
    scan.templateIdentifierDigests.length < 25
  ) {
    scan.templateIdentifierDigests.push(digest)
  }
}

function scanEvtxBinXmlMetadata(body: Buffer, scan: EvtxEventRecordScan) {
  const remainingBudget = Math.max(
    0,
    evtxBinXmlScanBytesLimit - scan.binXmlScanBytes,
  )
  if (remainingBudget === 0) {
    if (body.length > 0) scan.binXmlScanTruncated = true
    return
  }

  const window = body.subarray(0, Math.min(body.length, remainingBudget))
  if (window.length < body.length) scan.binXmlScanTruncated = true
  scan.binXmlScanBytes += window.length

  for (let index = 0; index < window.length; index++) {
    const token = window[index]
    const name = evtxBinXmlTokenNames[token]
    if (!name) continue
    addCount(scan.binXmlTokenCounts, name)
    if (token === 0x0c) {
      scan.binXmlTemplateInstanceCount++
      if (index + 17 <= window.length) {
        recordEvtxTemplateDigest(scan, window.subarray(index + 1, index + 17))
        index += 16
      }
    } else if (token === 0x0d) {
      scan.binXmlNormalSubstitutionCount++
    } else if (token === 0x0e) {
      scan.binXmlOptionalSubstitutionCount++
    } else if (token === 0x0f) {
      scan.binXmlFragmentHeaderCount++
    }
  }
}

function scanEvtxChunkEventRecords(chunk: Buffer, scan: EvtxEventRecordScan) {
  let offset = evtxChunkHeaderSize
  let recordsInChunk = 0

  while (
    offset + evtxEventRecordMinimumSize <= chunk.length &&
    scan.eventRecordSampleCount < evtxEventRecordSampleLimit
  ) {
    const recordOffset = chunk.indexOf(evtxEventRecordMagic, offset)
    if (
      recordOffset < 0 ||
      recordOffset + evtxEventRecordMinimumSize > chunk.length
    ) {
      break
    }

    const recordSize = chunk.readUInt32LE(recordOffset + 4)
    if (recordSize < evtxEventRecordMinimumSize) {
      scan.eventRecordSizeMismatchCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }
    if (recordOffset + recordSize > chunk.length) {
      scan.eventRecordTruncatedCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }

    const trailingSize = chunk.readUInt32LE(recordOffset + recordSize - 4)
    if (trailingSize !== recordSize) {
      scan.eventRecordSizeMismatchCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }

    const recordIdentifier = chunk.readBigUInt64LE(recordOffset + 8).toString()
    const timestamp = windowsFileTimeToIso(
      chunk.readBigUInt64LE(recordOffset + 16),
    )
    recordEvtxEventRecord(scan, recordSize, recordIdentifier, timestamp)
    scanEvtxBinXmlMetadata(
      chunk.subarray(
        recordOffset + evtxEventRecordHeaderSize,
        recordOffset + recordSize - 4,
      ),
      scan,
    )
    recordsInChunk++
    offset = recordOffset + recordSize
  }

  if (
    scan.eventRecordSampleCount >= evtxEventRecordSampleLimit &&
    offset + evtxEventRecordMinimumSize <= chunk.length &&
    chunk.indexOf(evtxEventRecordMagic, offset) >= 0
  ) {
    scan.eventRecordScanTruncated = true
  }

  if (recordsInChunk > 0) scan.chunkWithEventRecordsCount++
}

async function summarizeEvtxArtifact(
  path: string,
  bytes: number,
): Promise<ArtifactEvtxSummary | undefined> {
  const extension = extname(path).toLowerCase()
  const prefix = await readFilePrefix(path, Math.min(bytes, 128 * 1024))
  const formatDetected = prefix.toString('ascii').startsWith('ElfFile')
  if (extension !== '.evtx' && !formatDetected) return undefined

  const warnings: string[] = []
  let majorVersion: number | undefined
  let minorVersion: number | undefined
  let headerSize: number | undefined
  let headerBlockSize: number | undefined
  let firstChunkNumber: string | undefined
  let lastChunkNumber: string | undefined
  let nextRecordIdentifier: string | undefined
  let declaredChunkCount: number | undefined
  let detectedChunkHeaderCount = 0
  let chunkHeaderSampleCount = 0
  let chunkRecordNumberFirst: string | undefined
  let chunkRecordNumberLast: string | undefined
  let chunkRecordIdentifierFirst: string | undefined
  let chunkRecordIdentifierLast: string | undefined
  const eventRecordScan = emptyEvtxEventRecordScan()

  if (formatDetected && prefix.length >= 48) {
    firstChunkNumber = prefix.readBigUInt64LE(8).toString()
    lastChunkNumber = prefix.readBigUInt64LE(16).toString()
    nextRecordIdentifier = prefix.readBigUInt64LE(24).toString()
    headerSize = prefix.readUInt32LE(32)
    minorVersion = prefix.readUInt16LE(36)
    majorVersion = prefix.readUInt16LE(38)
    headerBlockSize = prefix.readUInt16LE(40)
    const firstChunk = Number(prefix.readBigUInt64LE(8))
    const lastChunk = Number(prefix.readBigUInt64LE(16))
    if (
      Number.isSafeInteger(firstChunk) &&
      Number.isSafeInteger(lastChunk) &&
      lastChunk >= firstChunk
    ) {
      declaredChunkCount = lastChunk - firstChunk + 1
    }
  } else if (formatDetected) {
    warnings.push('EVTX file header is truncated')
  }

  let chunkOffset = evtxFileHeaderSize
  while (chunkOffset + 128 <= prefix.length && chunkHeaderSampleCount < 32) {
    const chunk = prefix.subarray(
      chunkOffset,
      Math.min(prefix.length, chunkOffset + evtxChunkSize),
    )
    if (chunk.length < 8) break
    chunkHeaderSampleCount++
    if (chunk.toString('ascii', 0, 8).startsWith('ElfChnk')) {
      detectedChunkHeaderCount++
      scanEvtxChunkEventRecords(chunk, eventRecordScan)
      if (chunk.length >= 40) {
        const firstRecordNumber = chunk.readBigUInt64LE(8).toString()
        const lastRecordNumber = chunk.readBigUInt64LE(16).toString()
        const firstRecordIdentifier = chunk.readBigUInt64LE(24).toString()
        const lastRecordIdentifier = chunk.readBigUInt64LE(32).toString()
        chunkRecordNumberFirst =
          chunkRecordNumberFirst == null || firstRecordNumber < chunkRecordNumberFirst
            ? firstRecordNumber
            : chunkRecordNumberFirst
        chunkRecordNumberLast =
          chunkRecordNumberLast == null || lastRecordNumber > chunkRecordNumberLast
            ? lastRecordNumber
            : chunkRecordNumberLast
        chunkRecordIdentifierFirst =
          chunkRecordIdentifierFirst == null ||
          firstRecordIdentifier < chunkRecordIdentifierFirst
            ? firstRecordIdentifier
            : chunkRecordIdentifierFirst
        chunkRecordIdentifierLast =
          chunkRecordIdentifierLast == null ||
          lastRecordIdentifier > chunkRecordIdentifierLast
            ? lastRecordIdentifier
            : chunkRecordIdentifierLast
      }
    } else {
      warnings.push('EVTX chunk header sample did not contain expected chunk magic')
      break
    }
    chunkOffset += evtxChunkSize
  }

  return {
    formatDetected,
    bytes,
    majorVersion,
    minorVersion,
    headerSize,
    headerBlockSize,
    firstChunkNumber,
    lastChunkNumber,
    nextRecordIdentifier,
    declaredChunkCount,
    detectedChunkHeaderCount,
    chunkHeaderSampleCount,
    chunkRecordNumberFirst,
    chunkRecordNumberLast,
    chunkRecordIdentifierFirst,
    chunkRecordIdentifierLast,
    ...eventRecordScan,
    notes: [
      'Windows EVTX event record headers are parsed for bounded size, identifier, and timestamp metadata.',
      'EVTX BinXML bodies are scanned only for bounded token/template metadata, substitution counts, and template identifier digests.',
      'EVTX BinXML event bodies are not decoded or copied by this local summary.',
    ],
    warnings,
  }
}

function emptyPcapFlowSummary(): ArtifactPcapFlowSummary {
  return {
    parsedPacketCount: 0,
    totalCapturedBytes: 0,
    totalOriginalBytes: 0,
    etherTypeCounts: {},
    networkProtocolCounts: {},
    transportProtocolCounts: {},
    portCounts: {},
    tcpFlagCounts: {},
    flowHashSamples: [],
  }
}

function pcapTimestamp(
  seconds: number,
  fraction: number,
  resolution: 'microsecond' | 'nanosecond' | undefined,
): string | undefined {
  const millis =
    seconds * 1000 + fraction / (resolution === 'nanosecond' ? 1_000_000 : 1000)
  if (!Number.isFinite(millis)) return undefined
  const date = new Date(millis)
  const time = date.getTime()
  return Number.isFinite(time) ? date.toISOString() : undefined
}

function recordPcapTimestamp(
  flow: ArtifactPcapFlowSummary,
  timestamp: string | undefined,
) {
  if (!timestamp) return
  flow.firstPacketTime =
    flow.firstPacketTime == null || timestamp < flow.firstPacketTime
      ? timestamp
      : flow.firstPacketTime
  flow.lastPacketTime =
    flow.lastPacketTime == null || timestamp > flow.lastPacketTime
      ? timestamp
      : flow.lastPacketTime
}

function etherTypeName(etherType: number): string {
  switch (etherType) {
    case 0x0800:
      return 'ipv4'
    case 0x0806:
      return 'arp'
    case 0x86dd:
      return 'ipv6'
    default:
      return `0x${etherType.toString(16).padStart(4, '0')}`
  }
}

function ipProtocolName(protocol: number): string {
  switch (protocol) {
    case 1:
      return 'icmp'
    case 6:
      return 'tcp'
    case 17:
      return 'udp'
    case 58:
      return 'icmpv6'
    default:
      return `ip-proto-${protocol}`
  }
}

function recordPcapFlowHash(
  flow: ArtifactPcapFlowSummary,
  parts: string[],
) {
  const hash = createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 16)
  const sample = `flow:${hash}`
  if (!flow.flowHashSamples.includes(sample) && flow.flowHashSamples.length < 25) {
    flow.flowHashSamples.push(sample)
  }
}

function recordTcpFlags(flow: ArtifactPcapFlowSummary, flags: number) {
  const names: Array<[number, string]> = [
    [0x01, 'fin'],
    [0x02, 'syn'],
    [0x04, 'rst'],
    [0x08, 'psh'],
    [0x10, 'ack'],
    [0x20, 'urg'],
    [0x40, 'ece'],
    [0x80, 'cwr'],
  ]
  for (const [bit, name] of names) {
    if ((flags & bit) !== 0) addCount(flow.tcpFlagCounts, name)
  }
}

function parsePcapTransportHeader(
  flow: ArtifactPcapFlowSummary,
  packet: Buffer,
  offset: number,
  protocol: number,
  family: 'ipv4' | 'ipv6',
  src: string,
  dst: string,
) {
  const protocolName = ipProtocolName(protocol)
  addCount(flow.transportProtocolCounts, protocolName)

  if ((protocol === 6 || protocol === 17) && offset + 4 <= packet.length) {
    const sourcePort = packet.readUInt16BE(offset)
    const destinationPort = packet.readUInt16BE(offset + 2)
    addCount(flow.portCounts, `${protocolName}/${sourcePort}`)
    addCount(flow.portCounts, `${protocolName}/${destinationPort}`)
    if (protocol === 6 && offset + 14 <= packet.length) {
      recordTcpFlags(flow, packet[offset + 13] ?? 0)
    }
    const endpoints = [
      `${src}:${sourcePort}`,
      `${dst}:${destinationPort}`,
    ].sort()
    recordPcapFlowHash(flow, [family, protocolName, ...endpoints])
    return
  }

  recordPcapFlowHash(flow, [family, protocolName, ...[src, dst].sort()])
}

function parsePcapIpPacket(
  flow: ArtifactPcapFlowSummary,
  packet: Buffer,
  offset: number,
): boolean {
  if (offset >= packet.length) return false
  const version = (packet[offset] ?? 0) >> 4
  if (version === 4) {
    if (offset + 20 > packet.length) return false
    const headerLength = ((packet[offset] ?? 0) & 0x0f) * 4
    if (headerLength < 20 || offset + headerLength > packet.length) return false
    const protocol = packet[offset + 9] ?? 0
    const src = packet.subarray(offset + 12, offset + 16).toString('hex')
    const dst = packet.subarray(offset + 16, offset + 20).toString('hex')
    addCount(flow.networkProtocolCounts, 'ipv4')
    parsePcapTransportHeader(
      flow,
      packet,
      offset + headerLength,
      protocol,
      'ipv4',
      src,
      dst,
    )
    return true
  }

  if (version === 6) {
    if (offset + 40 > packet.length) return false
    const protocol = packet[offset + 6] ?? 0
    const src = packet.subarray(offset + 8, offset + 24).toString('hex')
    const dst = packet.subarray(offset + 24, offset + 40).toString('hex')
    addCount(flow.networkProtocolCounts, 'ipv6')
    parsePcapTransportHeader(
      flow,
      packet,
      offset + 40,
      protocol,
      'ipv6',
      src,
      dst,
    )
    return true
  }

  return false
}

function parsePcapPacketHeaders(
  flow: ArtifactPcapFlowSummary,
  packet: Buffer,
  linkType: number | undefined,
): boolean {
  if (linkType === 1) {
    if (packet.length < 14) return false
    let etherTypeOffset = 12
    let etherType = packet.readUInt16BE(etherTypeOffset)
    while (
      [0x8100, 0x88a8, 0x9100].includes(etherType) &&
      etherTypeOffset + 6 <= packet.length
    ) {
      etherTypeOffset += 4
      etherType = packet.readUInt16BE(etherTypeOffset)
    }
    addCount(flow.etherTypeCounts, etherTypeName(etherType))
    if (etherType === 0x0800 || etherType === 0x86dd) {
      return parsePcapIpPacket(flow, packet, etherTypeOffset + 2)
    }
    if (etherType === 0x0806) addCount(flow.networkProtocolCounts, 'arp')
    return true
  }

  if (linkType === 101 || linkType === 228 || linkType === 229) {
    return parsePcapIpPacket(flow, packet, 0)
  }

  if (linkType === 113) {
    if (packet.length < 16) return false
    const etherType = packet.readUInt16BE(14)
    addCount(flow.etherTypeCounts, etherTypeName(etherType))
    if (etherType === 0x0800 || etherType === 0x86dd) {
      return parsePcapIpPacket(flow, packet, 16)
    }
    return true
  }

  return false
}

type PcapNgEndianness = 'little' | 'big'

type PcapNgTimestampResolution = {
  base: 10 | 2
  exponent: number
  name: string
}

type PcapNgInterface = {
  linkType: number
  snapLength: number
  timestampResolution: PcapNgTimestampResolution
}

function emptyPcapNgSummary(): ArtifactPcapNgSummary {
  return {
    sectionCount: 0,
    interfaceCount: 0,
    enhancedPacketBlockCount: 0,
    simplePacketBlockCount: 0,
    packetBlockCount: 0,
    nameResolutionBlockCount: 0,
    interfaceStatisticsBlockCount: 0,
    blockTypeCounts: {},
    optionCounts: {},
    interfaceLinkTypeCounts: {},
    interfaceSnapLengthCounts: {},
    timestampResolutionCounts: {},
    unknownBlockTypeSamples: [],
  }
}

function pcapNgReadUInt16(
  buffer: Buffer,
  offset: number,
  endianness: PcapNgEndianness,
): number {
  return endianness === 'little'
    ? buffer.readUInt16LE(offset)
    : buffer.readUInt16BE(offset)
}

function pcapNgReadUInt32(
  buffer: Buffer,
  offset: number,
  endianness: PcapNgEndianness,
): number {
  return endianness === 'little'
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset)
}

function pcapNgPaddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4)
}

function pcapNgBlockTypeName(blockType: number): string {
  switch (blockType) {
    case 0x0a0d0d0a:
      return 'section-header'
    case 0x00000001:
      return 'interface-description'
    case 0x00000002:
      return 'packet'
    case 0x00000003:
      return 'simple-packet'
    case 0x00000004:
      return 'name-resolution'
    case 0x00000005:
      return 'interface-statistics'
    case 0x00000006:
      return 'enhanced-packet'
    default:
      return `unknown-0x${blockType.toString(16).padStart(8, '0')}`
  }
}

function pcapNgOptionName(optionCode: number, blockName: string): string {
  if (optionCode === 1) return 'opt-comment'
  if (blockName === 'section-header') {
    switch (optionCode) {
      case 2:
        return 'shb-hardware'
      case 3:
        return 'shb-os'
      case 4:
        return 'shb-user-application'
    }
  }
  if (blockName === 'interface-description') {
    switch (optionCode) {
      case 2:
        return 'if-name'
      case 3:
        return 'if-description'
      case 4:
        return 'if-ipv4-address'
      case 5:
        return 'if-ipv6-address'
      case 6:
        return 'if-mac-address'
      case 7:
        return 'if-eui-address'
      case 8:
        return 'if-speed'
      case 9:
        return 'if-timestamp-resolution'
      case 10:
        return 'if-time-zone'
      case 11:
        return 'if-filter'
      case 12:
        return 'if-os'
      case 13:
        return 'if-fcs-length'
      case 14:
        return 'if-timestamp-offset'
    }
  }
  return `${blockName}-option-${optionCode}`
}

function defaultPcapNgTimestampResolution(): PcapNgTimestampResolution {
  return { base: 10, exponent: 6, name: '10^-6' }
}

function decodePcapNgTimestampResolution(
  value: number,
): PcapNgTimestampResolution {
  const base = (value & 0x80) === 0 ? 10 : 2
  const exponent = value & 0x7f
  return { base, exponent, name: `${base}^-${exponent}` }
}

function pcapNgClassicTimestampResolution(
  resolution: PcapNgTimestampResolution,
): 'microsecond' | 'nanosecond' | undefined {
  if (resolution.base === 10 && resolution.exponent === 6) return 'microsecond'
  if (resolution.base === 10 && resolution.exponent === 9) return 'nanosecond'
  return undefined
}

function pcapNgTimestamp(
  timestampHigh: number,
  timestampLow: number,
  resolution: PcapNgTimestampResolution,
): string | undefined {
  const ticks = (BigInt(timestampHigh) << 32n) + BigInt(timestampLow)
  const divisor =
    resolution.base === 10
      ? 10n ** BigInt(resolution.exponent)
      : 1n << BigInt(resolution.exponent)
  if (divisor <= 0n) return undefined
  const millis = (ticks * 1000n) / divisor
  if (millis > 8_640_000_000_000_000n) return undefined
  const date = new Date(Number(millis))
  const time = date.getTime()
  return Number.isFinite(time) ? date.toISOString() : undefined
}

function parsePcapNgOptions(
  buffer: Buffer,
  start: number,
  end: number,
  endianness: PcapNgEndianness,
  summary: ArtifactPcapNgSummary,
  blockName: string,
  warnings: string[],
): { timestampResolution?: PcapNgTimestampResolution } {
  let offset = start
  let optionCount = 0
  let timestampResolution: PcapNgTimestampResolution | undefined

  while (offset + 4 <= end && optionCount < 1000) {
    const optionCode = pcapNgReadUInt16(buffer, offset, endianness)
    const optionLength = pcapNgReadUInt16(buffer, offset + 2, endianness)
    optionCount++
    offset += 4

    if (optionCode === 0) break

    const valueEnd = offset + optionLength
    if (valueEnd > end) {
      warnings.push('PCAPNG option metadata extends beyond the block boundary')
      break
    }

    addCount(summary.optionCounts, pcapNgOptionName(optionCode, blockName))
    if (
      blockName === 'interface-description' &&
      optionCode === 9 &&
      optionLength >= 1
    ) {
      timestampResolution = decodePcapNgTimestampResolution(buffer[offset] ?? 6)
    }

    offset += pcapNgPaddedLength(optionLength)
  }

  if (optionCount >= 1000) {
    warnings.push('PCAPNG option metadata hit the local option-count cap')
  }

  return timestampResolution ? { timestampResolution } : {}
}

function summarizePcapNgArtifact(
  prefix: Buffer,
  bytes: number,
  warnings: string[],
): ArtifactPcapSummary {
  const pcapng = emptyPcapNgSummary()
  const flow = emptyPcapFlowSummary()
  let offset = 0
  let blockCount = 0
  let packetHeaderSampleCount = 0
  let endianness: PcapNgEndianness | undefined
  let majorVersion: number | undefined
  let minorVersion: number | undefined
  let snapLength: number | undefined
  let linkType: number | undefined
  let timestampResolution: 'microsecond' | 'nanosecond' | undefined
  let interfaces: PcapNgInterface[] = []

  const recordUnknownBlock = (blockName: string) => {
    if (
      blockName.startsWith('unknown-') &&
      !pcapng.unknownBlockTypeSamples.includes(blockName) &&
      pcapng.unknownBlockTypeSamples.length < 25
    ) {
      pcapng.unknownBlockTypeSamples.push(blockName)
    }
  }

  const recordPacketSample = (
    iface: PcapNgInterface | undefined,
    capturedLength: number,
    originalLength: number,
    packetStart: number,
    packetLimit: number,
    timestamp: string | undefined,
  ) => {
    if (packetHeaderSampleCount >= 1000) return
    packetHeaderSampleCount++
    flow.totalCapturedBytes += capturedLength
    flow.totalOriginalBytes += originalLength
    recordPcapTimestamp(flow, timestamp)

    if (!iface) {
      warnings.push('PCAPNG packet block referenced an unknown interface')
      return
    }
    if (capturedLength > artifactScanBytesLimit) {
      warnings.push('PCAPNG packet sample includes a packet larger than the local scan cap')
      return
    }

    const packetEnd = packetStart + capturedLength
    if (packetEnd > packetLimit) {
      warnings.push('PCAPNG packet data extends beyond the block boundary')
      return
    }

    if (
      capturedLength > 0 &&
      parsePcapPacketHeaders(flow, prefix.subarray(packetStart, packetEnd), iface.linkType)
    ) {
      flow.parsedPacketCount++
    }
  }

  while (offset + 12 <= prefix.length && blockCount < 2000) {
    const sectionHeaderMagic = prefix.readUInt32BE(offset) === 0x0a0d0d0a
    let blockEndianness = endianness
    if (sectionHeaderMagic) {
      if (offset + 12 > prefix.length) {
        warnings.push('PCAPNG section header is truncated')
        break
      }
      const byteOrderMagic = prefix.readUInt32BE(offset + 8)
      if (byteOrderMagic === 0x1a2b3c4d) {
        blockEndianness = 'big'
      } else if (byteOrderMagic === 0x4d3c2b1a) {
        blockEndianness = 'little'
      } else {
        warnings.push('PCAPNG section header has an unrecognized byte-order magic')
        break
      }
    }

    if (!blockEndianness) {
      warnings.push('PCAPNG metadata did not start with a section header block')
      break
    }

    const blockType = sectionHeaderMagic
      ? 0x0a0d0d0a
      : pcapNgReadUInt32(prefix, offset, blockEndianness)
    const totalLength = pcapNgReadUInt32(prefix, offset + 4, blockEndianness)
    if (totalLength < 12 || totalLength % 4 !== 0) {
      warnings.push('PCAPNG block has an invalid total length')
      break
    }

    const blockEnd = offset + totalLength
    if (blockEnd > prefix.length) {
      warnings.push('PCAPNG block extends beyond the local metadata scan window')
      break
    }

    const trailingLength = pcapNgReadUInt32(prefix, blockEnd - 4, blockEndianness)
    if (trailingLength !== totalLength) {
      warnings.push('PCAPNG block trailing length does not match the header length')
    }

    const blockName = pcapNgBlockTypeName(blockType)
    addCount(pcapng.blockTypeCounts, blockName)
    recordUnknownBlock(blockName)

    if (blockType === 0x0a0d0d0a) {
      endianness = blockEndianness
      interfaces = []
      pcapng.sectionCount++
      if (totalLength < 28) {
        warnings.push('PCAPNG section header block is shorter than expected')
      } else {
        majorVersion = pcapNgReadUInt16(prefix, offset + 12, blockEndianness)
        minorVersion = pcapNgReadUInt16(prefix, offset + 14, blockEndianness)
        parsePcapNgOptions(
          prefix,
          offset + 24,
          blockEnd - 4,
          blockEndianness,
          pcapng,
          blockName,
          warnings,
        )
      }
    } else if (blockType === 0x00000001) {
      pcapng.interfaceCount++
      if (totalLength < 20) {
        warnings.push('PCAPNG interface description block is shorter than expected')
      } else {
        const iface: PcapNgInterface = {
          linkType: pcapNgReadUInt16(prefix, offset + 8, blockEndianness),
          snapLength: pcapNgReadUInt32(prefix, offset + 12, blockEndianness),
          timestampResolution: defaultPcapNgTimestampResolution(),
        }
        const options = parsePcapNgOptions(
          prefix,
          offset + 16,
          blockEnd - 4,
          blockEndianness,
          pcapng,
          blockName,
          warnings,
        )
        if (options.timestampResolution) {
          iface.timestampResolution = options.timestampResolution
        }
        interfaces.push(iface)
        linkType ??= iface.linkType
        snapLength ??= iface.snapLength
        timestampResolution ??= pcapNgClassicTimestampResolution(
          iface.timestampResolution,
        )
        addCount(pcapng.interfaceLinkTypeCounts, String(iface.linkType))
        addCount(pcapng.interfaceSnapLengthCounts, String(iface.snapLength))
        addCount(
          pcapng.timestampResolutionCounts,
          iface.timestampResolution.name,
        )
      }
    } else if (blockType === 0x00000006) {
      pcapng.enhancedPacketBlockCount++
      if (totalLength < 32) {
        warnings.push('PCAPNG enhanced packet block is shorter than expected')
      } else {
        const interfaceId = pcapNgReadUInt32(prefix, offset + 8, blockEndianness)
        const timestampHigh = pcapNgReadUInt32(prefix, offset + 12, blockEndianness)
        const timestampLow = pcapNgReadUInt32(prefix, offset + 16, blockEndianness)
        const capturedLength = pcapNgReadUInt32(prefix, offset + 20, blockEndianness)
        const originalLength = pcapNgReadUInt32(prefix, offset + 24, blockEndianness)
        const packetStart = offset + 28
        const optionsStart = packetStart + pcapNgPaddedLength(capturedLength)
        const iface = interfaces[interfaceId]
        recordPacketSample(
          iface,
          capturedLength,
          originalLength,
          packetStart,
          blockEnd - 4,
          iface
            ? pcapNgTimestamp(timestampHigh, timestampLow, iface.timestampResolution)
            : undefined,
        )
        if (optionsStart <= blockEnd - 4) {
          parsePcapNgOptions(
            prefix,
            optionsStart,
            blockEnd - 4,
            blockEndianness,
            pcapng,
            blockName,
            warnings,
          )
        }
      }
    } else if (blockType === 0x00000003) {
      pcapng.simplePacketBlockCount++
      if (totalLength < 16) {
        warnings.push('PCAPNG simple packet block is shorter than expected')
      } else {
        const originalLength = pcapNgReadUInt32(prefix, offset + 8, blockEndianness)
        const packetStart = offset + 12
        const capturedLength = Math.min(
          originalLength,
          Math.max(0, blockEnd - 4 - packetStart),
        )
        recordPacketSample(
          interfaces[0],
          capturedLength,
          originalLength,
          packetStart,
          blockEnd - 4,
          undefined,
        )
      }
    } else if (blockType === 0x00000002) {
      pcapng.packetBlockCount++
      if (totalLength < 32) {
        warnings.push('PCAPNG packet block is shorter than expected')
      } else {
        const interfaceId = pcapNgReadUInt16(prefix, offset + 8, blockEndianness)
        const timestampHigh = pcapNgReadUInt32(prefix, offset + 12, blockEndianness)
        const timestampLow = pcapNgReadUInt32(prefix, offset + 16, blockEndianness)
        const capturedLength = pcapNgReadUInt32(prefix, offset + 20, blockEndianness)
        const originalLength = pcapNgReadUInt32(prefix, offset + 24, blockEndianness)
        const packetStart = offset + 28
        const optionsStart = packetStart + pcapNgPaddedLength(capturedLength)
        const iface = interfaces[interfaceId]
        recordPacketSample(
          iface,
          capturedLength,
          originalLength,
          packetStart,
          blockEnd - 4,
          iface
            ? pcapNgTimestamp(timestampHigh, timestampLow, iface.timestampResolution)
            : undefined,
        )
        if (optionsStart <= blockEnd - 4) {
          parsePcapNgOptions(
            prefix,
            optionsStart,
            blockEnd - 4,
            blockEndianness,
            pcapng,
            blockName,
            warnings,
          )
        }
      }
    } else if (blockType === 0x00000004) {
      pcapng.nameResolutionBlockCount++
    } else if (blockType === 0x00000005) {
      pcapng.interfaceStatisticsBlockCount++
      if (totalLength >= 24) {
        parsePcapNgOptions(
          prefix,
          offset + 20,
          blockEnd - 4,
          blockEndianness,
          pcapng,
          blockName,
          warnings,
        )
      }
    }

    offset = blockEnd
    blockCount++
  }

  if (blockCount >= 2000) {
    warnings.push('PCAPNG metadata hit the local block-count cap')
  }
  if (packetHeaderSampleCount > 0 && flow.parsedPacketCount === 0) {
    warnings.push('PCAPNG packet blocks were sampled but no supported flow headers were parsed')
  }

  return {
    format: 'pcapng',
    bytes,
    endianness,
    timestampResolution,
    majorVersion,
    minorVersion,
    snapLength,
    linkType,
    packetHeaderSampleCount,
    flow: packetHeaderSampleCount > 0 ? flow : undefined,
    pcapng,
    truncated: offset < bytes,
    warnings,
  }
}

async function summarizePcapArtifact(
  path: string,
  bytes: number,
): Promise<ArtifactPcapSummary | undefined> {
  const extension = extname(path).toLowerCase()
  const prefix = await readFilePrefix(path, Math.min(bytes, 256 * 1024))
  if (prefix.length < 4) return undefined

  const warnings: string[] = []
  const magicBe = prefix.readUInt32BE(0)
  const magicLe = prefix.readUInt32LE(0)

  if (magicBe === 0x0a0d0d0a) {
    if (!['.pcap', '.pcapng', '.cap'].includes(extension)) {
      warnings.push('PCAPNG magic detected by content, not extension')
    }
    return summarizePcapNgArtifact(prefix, bytes, warnings)
  }

  let endianness: 'little' | 'big' | undefined
  let timestampResolution: 'microsecond' | 'nanosecond' | undefined
  if (magicBe === 0xa1b2c3d4) {
    endianness = 'big'
    timestampResolution = 'microsecond'
  } else if (magicLe === 0xa1b2c3d4) {
    endianness = 'little'
    timestampResolution = 'microsecond'
  } else if (magicBe === 0xa1b23c4d) {
    endianness = 'big'
    timestampResolution = 'nanosecond'
  } else if (magicLe === 0xa1b23c4d) {
    endianness = 'little'
    timestampResolution = 'nanosecond'
  } else if (!['.pcap', '.pcapng', '.cap'].includes(extension)) {
    return undefined
  } else {
    return {
      format: 'pcap',
      bytes,
      packetHeaderSampleCount: 0,
      truncated: false,
      warnings: ['PCAP extension was present but the global header was not recognized'],
    }
  }

  const readUInt16 =
    endianness === 'little'
      ? (offset: number) => prefix.readUInt16LE(offset)
      : (offset: number) => prefix.readUInt16BE(offset)
  const readUInt32 =
    endianness === 'little'
      ? (offset: number) => prefix.readUInt32LE(offset)
      : (offset: number) => prefix.readUInt32BE(offset)

  if (prefix.length < 24) {
    warnings.push('PCAP global header is truncated')
    return {
      format: 'pcap',
      bytes,
      endianness,
      timestampResolution,
      packetHeaderSampleCount: 0,
      truncated: true,
      warnings,
    }
  }

  let offset = 24
  let packetHeaderSampleCount = 0
  const linkType = readUInt32(20)
  const flow = emptyPcapFlowSummary()
  while (offset + 16 <= prefix.length && packetHeaderSampleCount < 1000) {
    const seconds = readUInt32(offset)
    const fraction = readUInt32(offset + 4)
    const capturedLength = readUInt32(offset + 8)
    const originalLength = readUInt32(offset + 12)
    packetHeaderSampleCount++
    flow.totalCapturedBytes += capturedLength
    flow.totalOriginalBytes += originalLength
    recordPcapTimestamp(
      flow,
      pcapTimestamp(seconds, fraction, timestampResolution),
    )
    if (capturedLength > artifactScanBytesLimit) {
      warnings.push('PCAP packet sample includes a packet larger than the local scan cap')
      break
    }
    const packetOffset = offset + 16
    const packetEnd = packetOffset + capturedLength
    if (packetEnd > prefix.length) {
      warnings.push('PCAP packet data extends beyond the local metadata scan window')
      break
    }
    if (
      capturedLength > 0 &&
      parsePcapPacketHeaders(flow, prefix.subarray(packetOffset, packetEnd), linkType)
    ) {
      flow.parsedPacketCount++
    }
    offset = packetEnd
  }

  if (packetHeaderSampleCount > 0 && flow.parsedPacketCount === 0) {
    warnings.push('PCAP packet headers were sampled but no supported flow headers were parsed')
  }

  return {
    format: 'pcap',
    bytes,
    endianness,
    timestampResolution,
    majorVersion: readUInt16(4),
    minorVersion: readUInt16(6),
    snapLength: readUInt32(16),
    linkType,
    packetHeaderSampleCount,
    flow: packetHeaderSampleCount > 0 ? flow : undefined,
    truncated: offset < bytes,
    warnings,
  }
}

function peMachineName(machine: number): string {
  switch (machine) {
    case 0x014c:
      return 'i386'
    case 0x8664:
      return 'amd64'
    case 0x01c0:
      return 'arm'
    case 0xaa64:
      return 'arm64'
    case 0x0200:
      return 'ia64'
    default:
      return `0x${machine.toString(16).padStart(4, '0')}`
  }
}

function peSubsystemName(subsystem: number): string {
  switch (subsystem) {
    case 1:
      return 'native'
    case 2:
      return 'windows-gui'
    case 3:
      return 'windows-cui'
    case 7:
      return 'posix-cui'
    case 9:
      return 'windows-ce-gui'
    case 10:
      return 'efi-application'
    case 11:
      return 'efi-boot-service-driver'
    case 12:
      return 'efi-runtime-driver'
    case 13:
      return 'efi-rom'
    case 14:
      return 'xbox'
    case 16:
      return 'windows-boot-application'
    default:
      return `subsystem-${subsystem}`
  }
}

function recordPeCharacteristics(target: Record<string, number>, flags: number) {
  const names: Array<[number, string]> = [
    [0x0002, 'executable-image'],
    [0x0020, 'large-address-aware'],
    [0x0100, '32bit-machine'],
    [0x0200, 'debug-stripped'],
    [0x2000, 'dll'],
    [0x4000, 'uniprocessor-only'],
  ]
  for (const [bit, name] of names) {
    if ((flags & bit) !== 0) addCount(target, name)
  }
}

function recordPeDllCharacteristics(
  target: Record<string, number>,
  flags: number,
) {
  const names: Array<[number, string]> = [
    [0x0020, 'high-entropy-va'],
    [0x0040, 'dynamic-base'],
    [0x0080, 'force-integrity'],
    [0x0100, 'nx-compatible'],
    [0x0200, 'no-isolation'],
    [0x0400, 'no-seh'],
    [0x0800, 'no-bind'],
    [0x1000, 'app-container'],
    [0x2000, 'wdm-driver'],
    [0x4000, 'guard-cf'],
    [0x8000, 'terminal-server-aware'],
  ]
  for (const [bit, name] of names) {
    if ((flags & bit) !== 0) addCount(target, name)
  }
}

function recordPeSectionCharacteristics(
  target: Record<string, number>,
  flags: number,
) {
  const names: Array<[number, string]> = [
    [0x00000020, 'code'],
    [0x00000040, 'initialized-data'],
    [0x00000080, 'uninitialized-data'],
    [0x02000000, 'discardable'],
    [0x04000000, 'not-cacheable'],
    [0x08000000, 'not-pageable'],
    [0x20000000, 'executable'],
    [0x40000000, 'readable'],
    [0x80000000, 'writable'],
  ]
  for (const [bit, name] of names) {
    if ((flags & bit) !== 0) addCount(target, name)
  }
}

function peTimestamp(seconds: number): string | undefined {
  if (seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

async function summarizePeArtifact(
  path: string,
  bytes: number,
): Promise<ArtifactPeSummary | undefined> {
  const extension = extname(path).toLowerCase()
  const prefix = await readFilePrefix(path, Math.min(bytes, 2 * 1024 * 1024))
  const extensionHint = [
    '.exe',
    '.dll',
    '.sys',
    '.ocx',
    '.cpl',
    '.scr',
    '.efi',
  ].includes(extension)
  const formatDetected =
    prefix.length >= 2 && prefix.toString('ascii', 0, 2) === 'MZ'
  if (!extensionHint && !formatDetected) return undefined

  const warnings: string[] = []
  const characteristicCounts: Record<string, number> = {}
  const dllCharacteristicCounts: Record<string, number> = {}
  const sectionCharacteristicCounts: Record<string, number> = {}
  const sectionNameDigests: string[] = []
  const notes = [
    'PE parser records bounded DOS, COFF, optional-header, data-directory, and section metadata only.',
    'Raw section names, import names, resources, strings, and executable contents are not copied.',
  ]

  if (prefix.length < 64 || !formatDetected) {
    warnings.push(
      formatDetected
        ? 'PE DOS header is truncated'
        : 'file extension suggests PE but MZ header was not detected',
    )
    return {
      formatDetected,
      bytes,
      characteristicCounts,
      dllCharacteristicCounts,
      sectionCharacteristicCounts,
      sectionCount: 0,
      executableSectionCount: 0,
      writableSectionCount: 0,
      readableSectionCount: 0,
      sectionNameDigests,
      notes,
      warnings,
    }
  }

  const peOffset = prefix.readUInt32LE(0x3c)
  if (peOffset + 24 > prefix.length) {
    warnings.push('PE header offset points beyond the local parser prefix')
    return {
      formatDetected,
      bytes,
      characteristicCounts,
      dllCharacteristicCounts,
      sectionCharacteristicCounts,
      sectionCount: 0,
      executableSectionCount: 0,
      writableSectionCount: 0,
      readableSectionCount: 0,
      sectionNameDigests,
      notes,
      warnings,
    }
  }

  if (prefix.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    warnings.push('MZ file did not include a PE signature at e_lfanew')
    return {
      formatDetected,
      bytes,
      characteristicCounts,
      dllCharacteristicCounts,
      sectionCharacteristicCounts,
      sectionCount: 0,
      executableSectionCount: 0,
      writableSectionCount: 0,
      readableSectionCount: 0,
      sectionNameDigests,
      notes,
      warnings,
    }
  }

  const machine = prefix.readUInt16LE(peOffset + 4)
  const numberOfSections = prefix.readUInt16LE(peOffset + 6)
  const timestamp = peTimestamp(prefix.readUInt32LE(peOffset + 8))
  const sizeOfOptionalHeader = prefix.readUInt16LE(peOffset + 20)
  const characteristics = prefix.readUInt16LE(peOffset + 22)
  recordPeCharacteristics(characteristicCounts, characteristics)

  const optionalStart = peOffset + 24
  const optionalEnd = optionalStart + sizeOfOptionalHeader
  let optionalHeaderMagic: string | undefined
  let subsystem: string | undefined
  let subsystemName: string | undefined
  let imageBase: string | undefined
  let entryPointRva: number | undefined
  let sizeOfImage: number | undefined
  let sizeOfHeaders: number | undefined
  let importDirectoryRva: number | undefined
  let importDirectorySize: number | undefined
  let certificateTableSize: number | undefined

  if (optionalEnd <= prefix.length && sizeOfOptionalHeader >= 72) {
    const magic = prefix.readUInt16LE(optionalStart)
    optionalHeaderMagic =
      magic === 0x10b
        ? 'pe32'
        : magic === 0x20b
          ? 'pe32-plus'
          : `0x${magic.toString(16)}`
    entryPointRva = prefix.readUInt32LE(optionalStart + 16)
    sizeOfImage = prefix.readUInt32LE(optionalStart + 56)
    sizeOfHeaders = prefix.readUInt32LE(optionalStart + 60)
    const subsystemValue = prefix.readUInt16LE(optionalStart + 68)
    subsystem = String(subsystemValue)
    subsystemName = peSubsystemName(subsystemValue)
    recordPeDllCharacteristics(
      dllCharacteristicCounts,
      prefix.readUInt16LE(optionalStart + 70),
    )
    if (magic === 0x10b && optionalStart + 96 <= optionalEnd) {
      imageBase = String(prefix.readUInt32LE(optionalStart + 28))
    } else if (magic === 0x20b && optionalStart + 112 <= optionalEnd) {
      imageBase = prefix.readBigUInt64LE(optionalStart + 24).toString()
    }

    const dataDirectoryStart =
      magic === 0x10b
        ? optionalStart + 96
        : magic === 0x20b
          ? optionalStart + 112
          : undefined
    if (dataDirectoryStart && dataDirectoryStart + 8 * 5 <= optionalEnd) {
      importDirectoryRva = prefix.readUInt32LE(dataDirectoryStart + 8)
      importDirectorySize = prefix.readUInt32LE(dataDirectoryStart + 12)
      certificateTableSize = prefix.readUInt32LE(dataDirectoryStart + 4 * 8 + 4)
    }
  } else {
    warnings.push('PE optional header is truncated')
  }

  let executableSectionCount = 0
  let writableSectionCount = 0
  let readableSectionCount = 0
  const sectionStart = optionalEnd
  for (let index = 0; index < numberOfSections && index < 96; index++) {
    const offset = sectionStart + index * 40
    if (offset + 40 > prefix.length) {
      warnings.push('PE section table is truncated')
      break
    }
    const rawName = prefix.subarray(offset, offset + 8)
    const nul = rawName.indexOf(0)
    const nameBytes = nul >= 0 ? rawName.subarray(0, nul) : rawName
    if (nameBytes.length > 0 && sectionNameDigests.length < 32) {
      sectionNameDigests.push(shortDigest(nameBytes.toString('binary')))
    }
    const sectionFlags = prefix.readUInt32LE(offset + 36)
    recordPeSectionCharacteristics(sectionCharacteristicCounts, sectionFlags)
    if ((sectionFlags & 0x20000000) !== 0) executableSectionCount++
    if ((sectionFlags & 0x80000000) !== 0) writableSectionCount++
    if ((sectionFlags & 0x40000000) !== 0) readableSectionCount++
  }
  if (numberOfSections > 96) {
    warnings.push('PE section table exceeded local parser section cap')
  }

  return {
    formatDetected,
    bytes,
    machine: `0x${machine.toString(16).padStart(4, '0')}`,
    machineName: peMachineName(machine),
    timestamp,
    characteristicCounts,
    optionalHeaderMagic,
    subsystem,
    subsystemName,
    dllCharacteristicCounts,
    imageBase,
    entryPointRva,
    sizeOfImage,
    sizeOfHeaders,
    sectionCount: numberOfSections,
    executableSectionCount,
    writableSectionCount,
    readableSectionCount,
    sectionCharacteristicCounts,
    sectionNameDigests,
    importDirectoryRva,
    importDirectorySize,
    certificateTableSize,
    notes,
    warnings,
  }
}

function registryHiveTypeName(value: number | undefined): string | undefined {
  if (value == null) return undefined
  switch (value) {
    case 0:
      return 'primary'
    case 1:
      return 'alternate'
    default:
      return String(value)
  }
}

async function summarizeRegistryHiveArtifact(
  path: string,
  bytes: number,
): Promise<ArtifactRegistryHiveSummary | undefined> {
  const extension = extname(path).toLowerCase()
  const prefix = await readFilePrefix(path, Math.min(bytes, 4 * 1024 * 1024))
  const formatDetected =
    prefix.length >= 4 && prefix.toString('ascii', 0, 4) === 'regf'
  const extensionHint = ['.hiv', '.hive', '.dat', '.regf'].includes(extension)
  if (!formatDetected && !extensionHint) return undefined

  const warnings: string[] = []
  if (!formatDetected) {
    warnings.push('file extension suggests registry hive but regf header was not detected')
  }

  let primarySequence: number | undefined
  let secondarySequence: number | undefined
  let lastWritten: string | undefined
  let majorVersion: number | undefined
  let minorVersion: number | undefined
  let type: number | undefined
  let format: number | undefined
  let rootCellOffset: number | undefined
  let hiveBinsDataSize: number | undefined
  let clusteringFactor: number | undefined
  let embeddedFileNameDigest: string | undefined

  if (formatDetected && prefix.length >= 4096) {
    primarySequence = prefix.readUInt32LE(4)
    secondarySequence = prefix.readUInt32LE(8)
    lastWritten = windowsFileTimeToIso(prefix.readBigUInt64LE(12))
    majorVersion = prefix.readUInt32LE(20)
    minorVersion = prefix.readUInt32LE(24)
    type = prefix.readUInt32LE(28)
    format = prefix.readUInt32LE(32)
    rootCellOffset = prefix.readUInt32LE(36)
    hiveBinsDataSize = prefix.readUInt32LE(40)
    clusteringFactor = prefix.readUInt32LE(44)
    const nameBytes = prefix.subarray(48, 48 + 64)
    const name = nameBytes.toString('utf16le').replace(/\0+$/g, '').trim()
    if (name) embeddedFileNameDigest = shortDigest(name)
  } else if (formatDetected) {
    warnings.push('registry hive base block is truncated')
  }

  let hbinHeaderCount = 0
  let hbinSizeBytes = 0
  let firstHbinOffset: number | undefined
  let lastHbinOffset: number | undefined
  let hbinScanTruncated = false
  let offset = 4096
  while (formatDetected && offset + 32 <= prefix.length && hbinHeaderCount < 1024) {
    if (prefix.toString('ascii', offset, offset + 4) !== 'hbin') {
      const next = prefix.indexOf('hbin', offset + 1, 'ascii')
      if (next < 0) break
      warnings.push('registry hive hbin headers were not contiguous in the parser prefix')
      offset = next
      continue
    }
    const hbinSize = prefix.readUInt32LE(offset + 8)
    if (hbinSize < 32 || hbinSize % 4096 !== 0) {
      warnings.push('registry hive hbin header had an invalid size')
      break
    }
    hbinHeaderCount++
    hbinSizeBytes += hbinSize
    firstHbinOffset = firstHbinOffset ?? offset
    lastHbinOffset = offset
    offset += hbinSize
  }
  if (hbinHeaderCount >= 1024 || (formatDetected && offset < bytes && offset >= prefix.length)) {
    hbinScanTruncated = true
  }

  return {
    formatDetected,
    bytes,
    primarySequence,
    secondarySequence,
    sequenceMismatch:
      primarySequence != null &&
      secondarySequence != null &&
      primarySequence !== secondarySequence,
    lastWritten,
    majorVersion,
    minorVersion,
    type,
    format,
    rootCellOffset,
    hiveBinsDataSize,
    clusteringFactor,
    embeddedFileNameDigest,
    hbinHeaderCount,
    hbinSizeBytes,
    firstHbinOffset,
    lastHbinOffset,
    hbinScanTruncated,
    notes: [
      `Registry hive type hint: ${registryHiveTypeName(type) ?? 'unknown'}.`,
      'Registry hive parser records base-block and hbin layout metadata only.',
      'Raw key names, values, security descriptors, and cell contents are not decoded or copied.',
    ],
    warnings,
  }
}

function headerDomain(value: string): string | undefined {
  const match = /@([A-Z0-9.-]+\.[A-Z]{2,})/i.exec(value)
  return match?.[1]?.toLowerCase()
}

function unfoldMailHeaders(block: string): string[] {
  const lines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += ` ${line.trim()}`
    } else {
      lines.push(line)
    }
  }
  return lines
}

function mailHeaderValueParameter(
  value: string,
  name: 'filename' | 'name',
): string | undefined {
  const pattern = new RegExp(
    `(?:^|;)\\s*${name}\\*?\\s*=\\s*(?:"([^"]*)"|([^;\\r\\n]*))`,
    'i',
  )
  const match = pattern.exec(value)
  const raw = match?.[1] ?? match?.[2]
  if (!raw) return undefined
  return raw.replace(/^utf-8''/i, '').trim()
}

function mailContentType(value: string): string | undefined {
  const raw = value.split(';', 1)[0]?.trim().toLowerCase()
  if (!raw || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw)) {
    return undefined
  }
  return raw
}

function mailDisposition(value: string): string | undefined {
  const raw = value.split(';', 1)[0]?.trim().toLowerCase()
  if (!raw || !/^[a-z0-9_.+-]+$/.test(raw)) return undefined
  return raw
}

function mailAttachmentExtension(value: string | undefined): string | undefined {
  if (!value) return undefined
  const decoded = value.replace(/%[0-9a-f]{2}/gi, '').replace(/[\\/]/g, '/')
  const lastSegment = decoded.split('/').pop()?.trim()
  if (!lastSegment) return undefined
  const extension = extname(lastSegment).toLowerCase()
  if (!extension) return '[none]'
  if (!/^\.[a-z0-9]{1,16}$/.test(extension)) return '[other]'
  return extension
}

function collectMailAttachmentMetadata(
  content: string,
  summary: ArtifactMailHeaderSummary,
) {
  const blocks = content.split(/\r?\n\r?\n/).slice(0, 1000)
  for (const block of blocks) {
    if (block.length > 16 * 1024) continue
    if (!/^(Content-Type|Content-Disposition):/im.test(block)) continue

    let contentType: string | undefined
    let disposition: string | undefined
    let filename: string | undefined

    for (const line of unfoldMailHeaders(block)) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      const header = line.slice(0, separator).trim().toLowerCase()
      const value = line.slice(separator + 1).trim()
      if (header === 'content-type') {
        contentType = mailContentType(value) ?? contentType
        filename = filename ?? mailHeaderValueParameter(value, 'name')
      }
      if (header === 'content-disposition') {
        disposition = mailDisposition(value) ?? disposition
        filename = filename ?? mailHeaderValueParameter(value, 'filename')
      }
    }

    const hasName = filename != null && filename.trim() !== ''
    const isAttachment =
      disposition === 'attachment' ||
      (disposition === 'inline' && hasName) ||
      (contentType != null && hasName)
    if (!isAttachment) continue

    summary.attachmentPartCount++
    if (hasName) summary.attachmentNameCount++
    if (disposition === 'inline') summary.inlineAttachmentCount++
    addCount(summary.attachmentDispositionCounts, disposition ?? 'unspecified')
    addCount(summary.attachmentContentTypeCounts, contentType ?? 'unknown')
    addCount(summary.attachmentExtensionCounts, mailAttachmentExtension(filename))
  }
}

function summarizeMailHeaders(content: string): ArtifactMailHeaderSummary | undefined {
  const blocks = content
    .split(/\r?\nFrom [^\n]*\r?\n/g)
    .map(block => block.split(/\r?\n\r?\n/, 1)[0] ?? '')
    .filter(block => /^(From|To|Date|Subject|Message-ID|Received):/im.test(block))
    .slice(0, 100)
  if (blocks.length === 0) return undefined

  const summary: ArtifactMailHeaderSummary = {
    messageCount: blocks.length,
    headerCounts: {},
    fromDomainCounts: {},
    recipientDomainCounts: {},
    receivedHopCounts: {},
    authenticationResultCount: 0,
    attachmentPartCount: 0,
    attachmentNameCount: 0,
    inlineAttachmentCount: 0,
    attachmentContentTypeCounts: {},
    attachmentExtensionCounts: {},
    attachmentDispositionCounts: {},
    warnings: [],
  }

  for (const block of blocks) {
    let receivedCount = 0
    for (const line of unfoldMailHeaders(block)) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      const header = line.slice(0, separator).trim().toLowerCase()
      const value = line.slice(separator + 1).trim()
      addCount(summary.headerCounts, header)
      if (header === 'from') {
        const domain = headerDomain(value)
        if (domain) addCount(summary.fromDomainCounts, domain)
      }
      if (header === 'to' || header === 'cc' || header === 'bcc') {
        for (const match of value.matchAll(/@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
          if (match[1]) addCount(summary.recipientDomainCounts, match[1].toLowerCase())
        }
      }
      if (header === 'received') receivedCount++
      if (header === 'authentication-results') summary.authenticationResultCount++
    }
    addCount(summary.receivedHopCounts, String(receivedCount))
  }

  collectMailAttachmentMetadata(content, summary)

  if (summary.authenticationResultCount === 0) {
    summary.warnings.push('mail headers did not include authentication-results metadata')
  }
  return summary
}

async function summarizeStructuredArtifact(
  path: string,
  content: string,
  textScanned: boolean,
  bytes: number,
): Promise<ArtifactStructuredSummary | undefined> {
  const extension = extname(path).toLowerCase()
  const summary = emptyStructuredSummary()

  if (textScanned && extension === '.csv') {
    const csv = summarizeCsvContent(content)
    if (csv) {
      pushUnique(summary.formats, 'siem-csv')
      pushUnique(summary.parsers, 'csv-events')
      summary.csv = csv
    }
  }

  if (textScanned && ['.json', '.stix'].includes(extension)) {
    const jsonSummary = summarizeJsonContent(path, content)
    if (jsonSummary) {
      for (const format of jsonSummary.formats) pushUnique(summary.formats, format)
      for (const parser of jsonSummary.parsers) pushUnique(summary.parsers, parser)
      summary.warnings.push(...jsonSummary.warnings)
      summary.stix = jsonSummary.stix
      summary.taxii = jsonSummary.taxii
      summary.jsonEvents = jsonSummary.jsonEvents
      summary.caseManifest = jsonSummary.caseManifest
    }
  }

  if (textScanned && ['.jsonl', '.ndjson'].includes(extension)) {
    const jsonlSummary = summarizeJsonLinesContent(content)
    if (jsonlSummary) {
      for (const format of jsonlSummary.formats) pushUnique(summary.formats, format)
      for (const parser of jsonlSummary.parsers) pushUnique(summary.parsers, parser)
      summary.warnings.push(...jsonlSummary.warnings)
      summary.jsonEvents = jsonlSummary.jsonEvents
    }
  }

  if (textScanned && ['.eml', '.mail', '.mime', '.txt', '.log'].includes(extension)) {
    const mailHeaders = summarizeMailHeaders(content)
    if (mailHeaders) {
      pushUnique(summary.formats, 'mail-headers')
      pushUnique(summary.parsers, 'mail-header-metadata')
      summary.mailHeaders = mailHeaders
    }
  }

  if (extension === '.zip') {
    const zip = await summarizeZipArtifact(path, bytes)
    pushUnique(summary.formats, 'zip-case-bundle')
    pushUnique(summary.parsers, 'zip-manifest')
    summary.zip = zip
  }

  const evtx = await summarizeEvtxArtifact(path, bytes)
  if (evtx) {
    pushUnique(summary.formats, 'windows-evtx')
    pushUnique(summary.parsers, 'evtx-metadata')
    summary.evtx = evtx
  }

  const pcap = await summarizePcapArtifact(path, bytes)
  if (pcap) {
    pushUnique(summary.formats, pcap.format === 'pcapng' ? 'pcapng-capture' : 'pcap-capture')
    pushUnique(summary.parsers, 'pcap-metadata')
    if (pcap.flow?.parsedPacketCount) {
      pushUnique(summary.parsers, 'pcap-flow-metadata')
    }
    if (pcap.pcapng?.sectionCount) {
      pushUnique(summary.parsers, 'pcapng-block-metadata')
    }
    summary.pcap = pcap
  }

  const pe = await summarizePeArtifact(path, bytes)
  if (pe) {
    pushUnique(summary.formats, 'windows-pe')
    pushUnique(summary.parsers, 'pe-metadata')
    summary.pe = pe
  }

  const registryHive = await summarizeRegistryHiveArtifact(path, bytes)
  if (registryHive) {
    pushUnique(summary.formats, 'windows-registry-hive')
    pushUnique(summary.parsers, 'registry-hive-metadata')
    summary.registryHive = registryHive
  }

  return summary.parsers.length > 0 || summary.warnings.length > 0
    ? summary
    : undefined
}

async function summarizeArtifactFile(path: string) {
  const info = await stat(path)
  const bytes = info.size
  const textScanned = isTextArtifact(path) && bytes <= artifactScanBytesLimit
  const content = textScanned ? await readFile(path, 'utf8') : ''
  const indicators = textScanned ? collectIndicators(content) : emptyIndicatorSummary()
  const timestamps = textScanned ? collectTimestamps(content) : { count: 0 }
  const keywordHits = textScanned ? collectKeywordHits(content) : {}
  const structured = await summarizeStructuredArtifact(
    path,
    content,
    textScanned,
    bytes,
  )

  return {
    path: projectPath(path),
    extension: extname(path).toLowerCase() || 'none',
    bytes,
    sha256: await sha256SmallFile(path, bytes),
    hashSkippedReason: bytes > artifactHashBytesLimit ? 'file exceeds local hash size limit' : undefined,
    textScanned,
    scannedBytes: textScanned ? Math.min(bytes, artifactScanBytesLimit) : 0,
    lineCount: textScanned ? content.split(/\r?\n/).length : undefined,
    indicators,
    timestamps,
    keywordHits,
    structured,
  }
}

async function runArtifactSummaryStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
): Promise<PlannedCommand> {
  if (!target.artifactPath) {
    throw new Error('artifact target path was not resolved')
  }

  const outputDir = join(runDir, 'raw')
  const outputPath = join(outputDir, 'artifact-summary.json')
  const rootInfo = await stat(target.artifactPath)
  const collection = await collectArtifactFiles(target.artifactPath)
  const files: Array<Awaited<ReturnType<typeof summarizeArtifactFile>>> = []
  const aggregate = {
    fileCount: 0,
    totalBytes: 0,
    scannedBytes: 0,
    indicatorCounts: {} as Record<string, number>,
    indicatorSamples: {} as Record<string, string[]>,
    keywordHits: {} as Record<string, number>,
    structured: emptyStructuredAggregate(),
    timestamps: {
      count: 0,
      first: undefined as string | undefined,
      last: undefined as string | undefined,
    },
  }

  for (const artifactFile of collection.files) {
    const summary = await summarizeArtifactFile(artifactFile)
    files.push(summary)
    aggregate.fileCount++
    aggregate.totalBytes += summary.bytes
    aggregate.scannedBytes += summary.scannedBytes
    mergeCounts(aggregate.indicatorCounts, summary.indicators.counts)
    mergeSamples(aggregate.indicatorSamples, summary.indicators.samples)
    mergeCounts(aggregate.keywordHits, summary.keywordHits)
    mergeStructuredSummary(aggregate.structured, summary.structured)
    aggregate.timestamps.count += summary.timestamps.count
    if (summary.timestamps.first) {
      aggregate.timestamps.first =
        aggregate.timestamps.first == null || summary.timestamps.first < aggregate.timestamps.first
          ? summary.timestamps.first
          : aggregate.timestamps.first
    }
    if (summary.timestamps.last) {
      aggregate.timestamps.last =
        aggregate.timestamps.last == null || summary.timestamps.last > aggregate.timestamps.last
          ? summary.timestamps.last
          : aggregate.timestamps.last
    }
  }

  await writeText(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        target: {
          raw: target.raw,
          path: projectPath(target.artifactPath),
          kind: rootInfo.isDirectory() ? 'directory' : 'file',
          matchedBy: target.matchedBy,
        },
        limits: {
          maxFiles: artifactFileLimit,
          maxTextScanBytesPerFile: artifactScanBytesLimit,
          maxHashBytesPerFile: artifactHashBytesLimit,
        },
        aggregate,
        files,
        truncated: collection.truncated,
        safety: {
          storesRawFileContents: false,
          storesRawLogLines: false,
          notes: [
            'RedScope stores file metadata, hashes, indicator counts, capped indicator samples, and timestamp bounds only.',
            'Raw artifact contents are not copied into the run summary.',
          ],
        },
      },
      null,
      2,
    )}\n`,
  )

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-artifact-summary', projectPath(target.artifactPath)],
    cwd: projectPath(repoRoot),
    outputFiles: [projectPath(outputPath)],
    status: 'executed',
  }
}

type SourceStateRecord = {
  id?: string
  repo?: string
  status?: string
  sourceDir?: string
  commitSha?: string
  downloadedAt?: string
}

type SourceState = {
  sources?: Record<string, SourceStateRecord>
}

type ConfidenceLabel = 'low' | 'medium' | 'high'

type ProductVersionPair = {
  product: string
  version: string
}

type ProductMetadata = {
  product: string
  aliases: string[]
  vendors: string[]
  cpe23Names: string[]
}

type OwnerConfirmedVersionEvidence = {
  product: string
  vendor?: string
  version: string
  cpe23Name?: string
  source: string
  evidenceId?: string
  target?: string
  observedAt?: string
  confidence: ConfidenceLabel
  notes: string[]
}

type FingerprintObservation = {
  source: 'header' | 'target' | 'html' | 'cookie' | 'body'
  name: string
  valueDigest: string
  products: string[]
  versions: string[]
  productVersionPairs: ProductVersionPair[]
  confidence: ConfidenceLabel
  score: number
}

type FingerprintSummary = {
  target: string
  headers: Record<string, string>
  products: string[]
  versions: string[]
  productVersionPairs: ProductVersionPair[]
  vendorHints: string[]
  cpe23Names: string[]
  productMetadata: ProductMetadata[]
  ownerConfirmedVersionEvidence: OwnerConfirmedVersionEvidence[]
  observations: FingerprintObservation[]
  matchTerms: string[]
  confidence: ConfidenceLabel
  confidenceScore: number
  evidenceNotes: string[]
}

type PocCandidate = {
  sourceId: string
  sourcePath: string
  relativeSourcePath: string
  matchedProducts: string[]
  matchedVersions: string[]
  matchedProductVersionPairs: ProductVersionPair[]
  matchedVendors: string[]
  matchedCpe23Names: string[]
  matchedCves: string[]
  contextSignals: string[]
  templateReview: TemplateReview
  evidenceClass: EvidenceClass
  evidenceScore: number
  confidence: ConfidenceLabel
  triageStatus: 'planned-validation' | 'triage-only'
  reason: string
}

type EvidenceClass =
  | 'public-intelligence-lead'
  | 'target-fingerprint-correlation'
  | 'owner-confirmed-target-version'
  | 'target-verified-issue'

type TemplateReviewStatus =
  | 'allowlisted-low-impact'
  | 'not-reviewed'
  | 'rejected'

type TemplateReview = {
  status: TemplateReviewStatus
  sourceId: string
  templateId?: string
  severity?: string
  tags: string[]
  reasons: string[]
}

type ExternalPocSearchProvider = 'github' | 'bing' | 'google' | 'baidu'

type ExternalPocSearchResult = {
  provider: ExternalPocSearchProvider
  query: string
  title: string
  url: string
  snippet?: string
  matchedProducts: string[]
  matchedVendors: string[]
  matchedVersions: string[]
  matchedCves: string[]
  evidenceScore: number
  confidence: ConfidenceLabel
  evidenceClass: EvidenceClass
  notes: string[]
}

type ExternalPocSearchProviderResult = {
  provider: ExternalPocSearchProvider
  query: string
  status: 'completed' | 'skipped' | 'failed'
  resultCount: number
  results: ExternalPocSearchResult[]
  reason?: string
}

type ExternalPocSearchSummary = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  providers: ExternalPocSearchProvider[]
  queryCount: number
  resultCount: number
  results: ExternalPocSearchResult[]
  providerResults: ExternalPocSearchProviderResult[]
  errors: Array<{
    provider: ExternalPocSearchProvider
    query: string
    reason: string
  }>
  policy: {
    targetHostIncludedInQueries: boolean
    arbitraryPocExecutionAllowed: boolean
    downloadsAllowed: boolean
    notes: string[]
  }
}

type VulnerabilityAdvisoryProvider = 'nvd'

type VulnerabilityAdvisoryQueryType = 'cveIds' | 'keyword' | 'cpeName'

type VulnerabilityAdvisoryRecord = {
  provider: VulnerabilityAdvisoryProvider
  cveId: string
  title: string
  descriptionSnippet?: string
  published?: string
  lastModified?: string
  vulnStatus?: string
  cvssVersion?: string
  cvssScore?: number
  cvssSeverity?: string
  cisaKev: boolean
  cisaExploitAdd?: string
  cisaActionDue?: string
  cisaVulnerabilityName?: string
  cpe23Names: string[]
  matchedProducts: string[]
  matchedVendors: string[]
  matchedVersions: string[]
  matchedCpe23Names: string[]
  matchedCves: string[]
  evidenceScore: number
  confidence: ConfidenceLabel
  evidenceClass: EvidenceClass
  references: string[]
  notes: string[]
}

type VulnerabilityAdvisoryQueryResult = {
  provider: VulnerabilityAdvisoryProvider
  queryType: VulnerabilityAdvisoryQueryType
  query: string
  status: 'completed' | 'skipped' | 'failed'
  resultCount: number
  cveIds: string[]
  reason?: string
}

type VulnerabilityAdvisorySummary = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  providers: VulnerabilityAdvisoryProvider[]
  queryCount: number
  resultCount: number
  advisories: VulnerabilityAdvisoryRecord[]
  queryResults: VulnerabilityAdvisoryQueryResult[]
  errors: Array<{
    provider: VulnerabilityAdvisoryProvider
    queryType: VulnerabilityAdvisoryQueryType
    query: string
    reason: string
  }>
  policy: {
    targetHostIncludedInQueries: boolean
    arbitraryPocExecutionAllowed: boolean
    downloadsAllowed: boolean
    notes: string[]
  }
}

type ValidationGateStatus = 'passed' | 'failed' | 'not-applicable'

type ValidationGateCheck = {
  id: string
  label: string
  status: ValidationGateStatus
  evidence: string[]
}

type SafeValidationCandidate = {
  sourceId: string
  sourcePath: string
  matchedProducts: string[]
  matchedVersions: string[]
  matchedVendors: string[]
  matchedCpe23Names: string[]
  matchedCves: string[]
  evidenceClass: EvidenceClass
  templateReview: TemplateReview
  gateScore: number
  status: 'ready-for-approved-low-impact-validation' | 'needs-manual-triage'
  confidence: ConfidenceLabel
  checks: ValidationGateCheck[]
  allowedFollowUp: string
}

type SafeValidationGateSummary = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  candidateCount: number
  validationReadyCount: number
  candidates: SafeValidationCandidate[]
  policy: {
    arbitraryPocExecutionAllowed: boolean
    networkProbeExecuted: boolean
    notes: string[]
  }
}

type LowImpactValidationMethod =
  | 'http-status'
  | 'http-header-present'
  | 'http-header-absent'
  | 'http-header-value-contains'
  | 'http-body-marker'

type LowImpactValidatorRecord = {
  id: string
  title: string
  method: LowImpactValidationMethod
  target: string
  request: {
    method: 'GET' | 'HEAD'
    url: string
    redirect: 'manual'
    bodySent: false
  }
  approval: {
    approvedBy: string
    approvalReference: string
  }
  status: 'verified' | 'not-verified' | 'skipped' | 'failed'
  impactVerified: boolean
  severity: 'info' | 'low' | 'medium'
  category: string
  evidence: string[]
  responseEvidence: {
    status?: number
    statusText?: string
    headerName?: string
    headerPresent?: boolean
    headerValueDigest?: string
    expectedValueDigest?: string
    bodySampleSha256?: string
    bodySampledBytes?: number
    bodySampleTruncated?: boolean
    bodyMarkerDigest?: string
    bodyMarkerMatched?: boolean
    rawBodyStored: false
  }
  impact: string
  remediation: string
  references: string[]
  candidateCves: string[]
  cpe23Names: string[]
  notes: string[]
  error?: string
}

type LowImpactValidationSummary = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  target: string
  validatorCount: number
  verifiedCount: number
  results: LowImpactValidatorRecord[]
  policy: {
    arbitraryPocExecutionAllowed: boolean
    allowedRequestMethods: Array<'GET' | 'HEAD'>
    maxRequestsPerValidator: number
    requestBodyAllowed: boolean
    rawBodyStored: false
    notes: string[]
  }
}

type BusinessLogicValidationMode =
  | 'safe-readonly-http'
  | 'approved-state-changing-http'
  | 'evidence-only'
  | 'manual-review'

type BusinessLogicHttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'

type BusinessLogicTestCategory =
  | 'horizontal-authorization'
  | 'vertical-authorization'
  | 'idor'
  | 'payment-flow'
  | 'refund-flow'
  | 'coupon-abuse'
  | 'workflow-state'
  | 'file-upload'
  | 'sql-injection'
  | 'business-logic'
  | 'other'

type BusinessLogicActorSessionSource =
  | 'environment'
  | 'login-token'
  | 'login-cookie'
  | 'missing'
  | 'login-failed'

type BusinessLogicActorSessionMaterial = {
  id: string
  headerName?: string
  headerValue?: string
  headerConfigured: boolean
  headerDigest?: string
  source: BusinessLogicActorSessionSource
  error?: string
  guidance: string[]
}

type BusinessLogicActorRecord = {
  id: string
  role?: string
  headerName?: string
  headerConfigured: boolean
  headerDigest?: string
  headerSource?: BusinessLogicActorSessionSource
  sessionError?: string
  sessionGuidance: string[]
  notes: string[]
}

type BusinessLogicRequestEvidence = {
  actorId: string
  role?: string
  method: BusinessLogicHttpMethod
  url: string
  status?: number
  statusText?: string
  requestBodySha256?: string
  requestBodyStored?: false
  bodySampleSha256?: string
  bodySampledBytes?: number
  bodySampleTruncated?: boolean
  bodyMarkerDigest?: string
  bodyMarkerMatched?: boolean
  rawBodyStored: false
  headerValueStored: false
  error?: string
}

type BusinessLogicValidationRecord = {
  id: string
  title: string
  category: BusinessLogicTestCategory
  validationMode: BusinessLogicValidationMode
  target: string
  approval: {
    approvedBy: string
    approvalReference: string
  }
  actors: {
    controlActor?: string
    testActor?: string
    objectOwnerActor?: string
  }
  affectedObject?: string
  status: 'verified' | 'not-verified' | 'skipped' | 'failed' | 'manual-review'
  impactVerified: boolean
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  evidence: string[]
  requestEvidence: BusinessLogicRequestEvidence[]
  manualEvidenceRefs: string[]
  preconditionEvidenceRefs?: string[]
  rollbackPlan?: string
  expectedOutcome?: string
  observedOutcome?: string
  impact: string
  remediation: string
  references: string[]
  cweIds: string[]
  notes: string[]
  parallelGroup?: string
  isolatedTestFamily?: string
  error?: string
}

type BusinessLogicValidationSummary = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  target: string
  actorCount: number
  testCaseCount: number
  verifiedCount: number
  actors: BusinessLogicActorRecord[]
  results: BusinessLogicValidationRecord[]
  parallelExecutionPlan: Array<{
    groupId: string
    isolatedTestFamilies: string[]
    testCaseIds: string[]
    canRunInParallel: boolean
    notes: string[]
  }>
  policy: {
    arbitraryPocExecutionAllowed: boolean
    defaultNetworkMode: BusinessLogicValidationMode
    mutatingRequestsAllowedByDefault: boolean
    approvedMutatingHttpAllowed?: boolean
    maxMutatingRequests?: number
    paymentCaptureAllowed: false
    destructiveUploadAllowed: false
    rawBodyStored: false
    secretHeaderStored: false
    notes: string[]
  }
}

const pocCandidateFileLimit = 1200
const pocCandidateReadBytes = 64 * 1024
const pocCandidateMaxMatches = 75
const pocCandidateMaxTriage = 150
const externalPocSearchMaxQueries = 4
const externalPocSearchResultsPerProvider = 5
const externalPocSearchTimeoutMs = 8_000
const advisoryEnrichmentMaxQueries = 4
const advisoryEnrichmentResultsPerQuery = 8
const advisoryEnrichmentTimeoutMs = 10_000
const httpBaselineBodySampleBytes = 96 * 1024
const lowImpactValidatorBodySampleBytes = 32 * 1024
const pocCandidateExtensions = new Set([
  '.yaml',
  '.yml',
  '.json',
  '.md',
  '.txt',
  '.py',
  '.rb',
  '.go',
  '.js',
  '.ts',
  '.java',
])
const fingerprintHeaderNames = [
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-generator',
  'x-drupal-cache',
  'x-drupal-dynamic-cache',
  'x-nextjs-cache',
  'x-rails-version',
  'x-magento-cache-debug',
  'x-litespeed-cache',
  'x-shopify-stage',
]
const fingerprintHeaderScore: Record<string, number> = {
  server: 28,
  'x-powered-by': 42,
  'x-aspnet-version': 48,
  'x-generator': 50,
  'x-drupal-cache': 34,
  'x-drupal-dynamic-cache': 34,
  'x-nextjs-cache': 34,
  'x-rails-version': 46,
  'x-magento-cache-debug': 38,
  'x-litespeed-cache': 34,
  'x-shopify-stage': 34,
}
const fingerprintHeaderImpliedProducts: Record<string, string[]> = {
  'x-aspnet-version': ['aspnet'],
  'x-drupal-cache': ['drupal'],
  'x-drupal-dynamic-cache': ['drupal'],
  'x-nextjs-cache': ['nextjs'],
  'x-rails-version': ['rails'],
  'x-magento-cache-debug': ['magento'],
  'x-litespeed-cache': ['litespeed'],
  'x-shopify-stage': ['shopify'],
}
const ignoredFingerprintTerms = new Set([
  'server',
  'powered',
  'by',
  'http',
  'https',
  'openresty',
  'cloudflare',
  'microsoft',
  'windows',
  'unix',
  'ubuntu',
  'debian',
  'centos',
  'unknown',
])
const productAliases: Record<string, string[]> = {
  angular: ['angular', 'angularjs'],
  apache: ['apache', 'httpd', 'apache http server'],
  aspnet: ['aspnet', 'asp.net', 'aspnetmvc', 'aspnetcore'],
  django: ['django'],
  drupal: ['drupal'],
  express: ['express', 'expressjs'],
  flask: ['flask'],
  iis: ['iis', 'internet information services'],
  jboss: ['jboss', 'wildfly'],
  jenkins: ['jenkins'],
  jetty: ['jetty'],
  joomla: ['joomla'],
  laravel: ['laravel'],
  litespeed: ['litespeed', 'openlitespeed', 'lsws'],
  magento: ['magento', 'adobe commerce'],
  nginx: ['nginx'],
  nextjs: ['nextjs', 'next.js'],
  nuxt: ['nuxt', 'nuxtjs', 'nuxt.js'],
  php: ['php'],
  rails: ['rails', 'ruby on rails'],
  shopify: ['shopify'],
  spring: ['spring', 'springboot', 'spring boot'],
  tomcat: ['tomcat', 'apache tomcat'],
  vue: ['vue', 'vuejs', 'vue.js'],
  woocommerce: ['woocommerce', 'woo commerce'],
  wordpress: ['wordpress', 'wp-content', 'wp-includes'],
}
type ProductCatalogEntry = {
  aliases: string[]
  vendors: string[]
  cpeVendor: string
  cpeProduct: string
  cpePart?: 'a' | 'o' | 'h'
}
const productCatalog: Record<string, ProductCatalogEntry> = {
  angular: {
    aliases: ['angular', 'angularjs'],
    vendors: ['google'],
    cpeVendor: 'google',
    cpeProduct: 'angular',
  },
  apache: {
    aliases: ['apache', 'httpd', 'apache http server'],
    vendors: ['apache'],
    cpeVendor: 'apache',
    cpeProduct: 'http_server',
  },
  aspnet: {
    aliases: ['aspnet', 'asp.net', 'aspnetmvc', 'aspnetcore'],
    vendors: ['microsoft'],
    cpeVendor: 'microsoft',
    cpeProduct: 'asp.net',
  },
  django: {
    aliases: ['django'],
    vendors: ['djangoproject'],
    cpeVendor: 'djangoproject',
    cpeProduct: 'django',
  },
  drupal: {
    aliases: ['drupal'],
    vendors: ['drupal'],
    cpeVendor: 'drupal',
    cpeProduct: 'drupal',
  },
  express: {
    aliases: ['express', 'expressjs'],
    vendors: ['expressjs'],
    cpeVendor: 'expressjs',
    cpeProduct: 'express',
  },
  flask: {
    aliases: ['flask'],
    vendors: ['palletsprojects'],
    cpeVendor: 'palletsprojects',
    cpeProduct: 'flask',
  },
  iis: {
    aliases: ['iis', 'internet information services'],
    vendors: ['microsoft'],
    cpeVendor: 'microsoft',
    cpeProduct: 'internet_information_services',
  },
  jboss: {
    aliases: ['jboss', 'wildfly'],
    vendors: ['redhat'],
    cpeVendor: 'redhat',
    cpeProduct: 'jboss_enterprise_application_platform',
  },
  jenkins: {
    aliases: ['jenkins'],
    vendors: ['jenkins'],
    cpeVendor: 'jenkins',
    cpeProduct: 'jenkins',
  },
  jetty: {
    aliases: ['jetty', 'eclipse jetty'],
    vendors: ['eclipse'],
    cpeVendor: 'eclipse',
    cpeProduct: 'jetty',
  },
  joomla: {
    aliases: ['joomla'],
    vendors: ['joomla'],
    cpeVendor: 'joomla',
    cpeProduct: 'joomla\\!',
  },
  laravel: {
    aliases: ['laravel'],
    vendors: ['laravel'],
    cpeVendor: 'laravel',
    cpeProduct: 'laravel',
  },
  litespeed: {
    aliases: ['litespeed', 'openlitespeed', 'lsws'],
    vendors: ['litespeedtech'],
    cpeVendor: 'litespeedtech',
    cpeProduct: 'litespeed_web_server',
  },
  magento: {
    aliases: ['magento', 'adobe commerce'],
    vendors: ['adobe', 'magento'],
    cpeVendor: 'adobe',
    cpeProduct: 'magento',
  },
  nginx: {
    aliases: ['nginx'],
    vendors: ['f5', 'nginx'],
    cpeVendor: 'f5',
    cpeProduct: 'nginx',
  },
  nextjs: {
    aliases: ['nextjs', 'next.js'],
    vendors: ['vercel'],
    cpeVendor: 'vercel',
    cpeProduct: 'next.js',
  },
  nuxt: {
    aliases: ['nuxt', 'nuxtjs', 'nuxt.js'],
    vendors: ['nuxt'],
    cpeVendor: 'nuxt',
    cpeProduct: 'nuxt',
  },
  php: {
    aliases: ['php'],
    vendors: ['php'],
    cpeVendor: 'php',
    cpeProduct: 'php',
  },
  rails: {
    aliases: ['rails', 'ruby on rails'],
    vendors: ['rubyonrails'],
    cpeVendor: 'rubyonrails',
    cpeProduct: 'rails',
  },
  spring: {
    aliases: ['spring', 'springboot', 'spring boot'],
    vendors: ['vmware', 'pivotal'],
    cpeVendor: 'vmware',
    cpeProduct: 'spring_framework',
  },
  tomcat: {
    aliases: ['tomcat', 'apache tomcat'],
    vendors: ['apache'],
    cpeVendor: 'apache',
    cpeProduct: 'tomcat',
  },
  vue: {
    aliases: ['vue', 'vuejs', 'vue.js'],
    vendors: ['vuejs'],
    cpeVendor: 'vuejs',
    cpeProduct: 'vue.js',
  },
  woocommerce: {
    aliases: ['woocommerce', 'woo commerce'],
    vendors: ['automattic'],
    cpeVendor: 'automattic',
    cpeProduct: 'woocommerce',
  },
  wordpress: {
    aliases: ['wordpress', 'wp-content', 'wp-includes'],
    vendors: ['wordpress'],
    cpeVendor: 'wordpress',
    cpeProduct: 'wordpress',
  },
}
const ownerConfirmedEvidenceSources = new Set([
  'owner-confirmed',
  'service-owner',
  'asset-inventory',
  'cmdb',
  'authenticated-admin',
  'vendor-console',
])
const reviewedTemplateSourceIds = new Set(['nuclei-templates'])
const reviewedTemplatePathPrefixes = [
  'http/cves/',
  'http/exposures/',
  'http/misconfiguration/',
  'http/technologies/',
  'network/detection/',
  'ssl/',
  'dns/',
]
const reviewedTemplateSeverities = new Set(['info', 'low'])
const rejectedTemplateTags = new Set([
  'bruteforce',
  'brute-force',
  'credential',
  'default-login',
  'dos',
  'fuzz',
  'fuzzing',
  'intrusive',
  'lfi',
  'malware',
  'rce',
  'sqli',
  'ssrf',
  'takeover',
  'upload',
  'xxe',
])
const pocContextSignals = [
  'cve',
  'vulnerability',
  'affected',
  'template',
  'matcher',
  'detect',
  'version',
  'advisory',
  'security',
  'exposure',
  'misconfiguration',
]
const sourceTrustScores: Record<string, number> = {
  'nuclei-templates': 22,
  vulhub: 16,
  xray: 14,
  'metasploit-framework': 12,
  pocsuite3: 12,
  'trickest-cve': 10,
  'poc-in-github': 8,
}
function isExternalPocSearchProvider(
  value: string,
): value is ExternalPocSearchProvider {
  return (
    value === 'github' ||
    value === 'bing' ||
    value === 'google' ||
    value === 'baidu'
  )
}

const externalPocSearchProviders: ExternalPocSearchProvider[] = envList(
  'REDSCOPE_TOOLS_EXTERNAL_POC_PROVIDERS',
  ['github', 'bing', 'google', 'baidu'],
).filter(isExternalPocSearchProvider)
const externalSearchHeaders = {
  'User-Agent':
    'Mozilla/5.0 (compatible; RedScope-AI-PoC-Search/1.0; +https://redscope.local)',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
} as const

function recordStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.trim()) result[key.toLowerCase()] = item
  }
  return result
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const item = value?.[key]
  return isRecord(item) ? item : undefined
}

function arrayField(value: Record<string, unknown> | undefined, key: string): unknown[] {
  const item = value?.[key]
  return Array.isArray(item) ? item : []
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const item = value?.[key]
  return typeof item === 'string' && item.trim() ? item : undefined
}

function numberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const item = value?.[key]
  return typeof item === 'number' && Number.isFinite(item) ? item : undefined
}

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

function uniquePairs(values: Iterable<ProductVersionPair>): ProductVersionPair[] {
  const seen = new Set<string>()
  const result: ProductVersionPair[] = []
  for (const value of values) {
    const product = value.product.trim().toLowerCase()
    const version = value.version.trim().toLowerCase()
    if (!product || !version) continue
    const key = `${product}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ product, version })
  }
  return result.sort((a, b) =>
    `${a.product}@${a.version}`.localeCompare(`${b.product}@${b.version}`),
  )
}

function confidenceFromScore(score: number): ConfidenceLabel {
  if (score >= 75) return 'high'
  if (score >= 45) return 'medium'
  return 'low'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsTerm(haystack: string, term: string): boolean {
  const normalized = term.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes(' ')) return haystack.includes(normalized)
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, 'i').test(
    haystack,
  )
}

function canonicalProductName(product: string): string {
  const normalized = product.trim().toLowerCase()
  if (!normalized) return ''
  if (productAliases[normalized] || productCatalog[normalized]) return normalized
  for (const [canonical, aliases] of Object.entries(productAliases)) {
    if (aliases.includes(normalized)) return canonical
  }
  for (const [canonical, entry] of Object.entries(productCatalog)) {
    if (entry.aliases.includes(normalized)) return canonical
  }
  return normalized
}

function productMatchTerms(product: string): string[] {
  const normalized = canonicalProductName(product)
  const catalog = productCatalog[normalized]
  return uniqueSorted([
    normalized,
    ...(productAliases[normalized] ?? []),
    ...(catalog?.aliases ?? []),
    catalog?.cpeProduct.replace(/\\!/g, '!') ?? '',
  ])
}

function productVendors(product: string): string[] {
  const catalog = productCatalog[canonicalProductName(product)]
  return uniqueSorted(catalog?.vendors ?? [])
}

function cpeVersion(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return '*'
  if (!/^[a-z0-9._+-]+$/.test(normalized)) return '*'
  return normalized
}

function cpe23NameForProduct(product: string, version?: string): string | undefined {
  const catalog = productCatalog[canonicalProductName(product)]
  if (!catalog) return undefined
  return `cpe:2.3:${catalog.cpePart ?? 'a'}:${catalog.cpeVendor}:${catalog.cpeProduct}:${cpeVersion(version)}:*:*:*:*:*:*:*`
}

function normalizeCpe23Name(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || !normalized.startsWith('cpe:2.3:')) return undefined
  const parts = normalized.split(':')
  if (parts.length < 6) return undefined
  return normalized
}

function extractCpe23Names(value: string): string[] {
  return uniqueSorted(
    (value.match(/\bcpe:2\.3:[aho]:[^\s"'<>`]+/gi) ?? [])
      .map(item => normalizeCpe23Name(item))
      .filter((item): item is string => Boolean(item)),
  )
}

function cpeKey(value: string): { vendor: string; product: string; version: string } | undefined {
  const normalized = normalizeCpe23Name(value)
  if (!normalized) return undefined
  const parts = normalized.split(':')
  return {
    vendor: parts[3] ?? '',
    product: parts[4] ?? '',
    version: parts[5] ?? '',
  }
}

function cpeNamesMatch(left: string, right: string): boolean {
  const leftKey = cpeKey(left)
  const rightKey = cpeKey(right)
  if (!leftKey || !rightKey) return false
  if (leftKey.vendor !== rightKey.vendor || leftKey.product !== rightKey.product) {
    return false
  }
  return (
    leftKey.version === '*' ||
    rightKey.version === '*' ||
    leftKey.version === rightKey.version
  )
}

function productMetadata(
  products: string[],
  versions: string[],
  ownerEvidence: OwnerConfirmedVersionEvidence[],
): ProductMetadata[] {
  return products.map(product => {
    const canonical = canonicalProductName(product)
    const catalog = productCatalog[canonical]
    const ownerCpes = ownerEvidence
      .filter(item => canonicalProductName(item.product) === canonical)
      .map(item => item.cpe23Name)
      .filter((item): item is string => Boolean(item))
    const inferredCpes = (versions.length > 0 ? versions.slice(0, 3) : ['*'])
      .map(version => cpe23NameForProduct(canonical, version))
      .filter((item): item is string => Boolean(item))
    return {
      product: canonical,
      aliases: productMatchTerms(canonical),
      vendors: uniqueSorted([...(catalog?.vendors ?? []), ...ownerEvidence
        .filter(item => canonicalProductName(item.product) === canonical)
        .map(item => item.vendor)
        .filter((item): item is string => Boolean(item))]),
      cpe23Names: uniqueSorted([...ownerCpes, ...inferredCpes]),
    }
  })
}

function extractVersions(value: string): string[] {
  return uniqueSorted(
    (value.match(/\b\d+(?:\.\d+){1,3}(?:[-_a-z0-9.]*)?\b/gi) ?? []).map(item =>
      item.toLowerCase(),
    ),
  )
}

function extractProducts(value: string): string[] {
  return uniqueSorted(
    (value.match(/[a-z][a-z0-9_-]{2,}/gi) ?? [])
      .map(item => canonicalProductName(item))
      .filter(item => !ignoredFingerprintTerms.has(item)),
  )
}

function extractProductVersionPairs(
  value: string,
  products: string[],
  versions: string[],
): ProductVersionPair[] {
  const haystack = value.toLowerCase()
  const pairs: ProductVersionPair[] = []
  for (const product of products) {
    for (const alias of productMatchTerms(product)) {
      for (const version of versions) {
        const productThenVersion = new RegExp(
          `${escapeRegExp(alias)}[^\\n\\r]{0,32}${escapeRegExp(version)}`,
          'i',
        )
        const versionThenProduct = new RegExp(
          `${escapeRegExp(version)}[^\\n\\r]{0,32}${escapeRegExp(alias)}`,
          'i',
        )
        if (productThenVersion.test(haystack) || versionThenProduct.test(haystack)) {
          pairs.push({ product, version })
        }
      }
    }
  }
  return uniquePairs(pairs)
}

function buildFingerprintObservation(
  source: FingerprintObservation['source'],
  name: string,
  value: string,
  impliedProducts: string[] = [],
  baseScore = 20,
): FingerprintObservation | undefined {
  const products = uniqueSorted([
    ...extractProducts(value),
    ...impliedProducts,
  ])
  const versions = extractVersions(value)
  const productVersionPairs = extractProductVersionPairs(value, products, versions)
  if (products.length === 0 && versions.length === 0) return undefined

  const score = Math.min(
    100,
    baseScore +
      Math.min(products.length, 4) * 5 +
      Math.min(versions.length, 3) * 8 +
      Math.min(productVersionPairs.length, 3) * 12,
  )

  return {
    source,
    name,
    valueDigest: shortDigest(value),
    products,
    versions,
    productVersionPairs,
    confidence: confidenceFromScore(score),
    score,
  }
}

function fingerprintObservation(
  name: string,
  value: string,
): FingerprintObservation | undefined {
  return buildFingerprintObservation(
    'header',
    name,
    value,
    fingerprintHeaderImpliedProducts[name] ?? [],
    fingerprintHeaderScore[name] ?? 20,
  )
}

function fingerprintObservationFromRecord(
  value: unknown,
): FingerprintObservation | undefined {
  if (!isRecord(value)) return undefined
  const source = stringField(value, 'source')
  if (
    source !== 'header' &&
    source !== 'target' &&
    source !== 'html' &&
    source !== 'cookie' &&
    source !== 'body'
  ) {
    return undefined
  }
  const name = stringField(value, 'name')
  const valueDigest = stringField(value, 'valueDigest')
  const products = uniqueSorted(list(value.products))
  const versions = uniqueSorted(list(value.versions))
  const productVersionPairs = uniquePairs(
    arrayField(value, 'productVersionPairs')
      .filter(isRecord)
      .map(pair => ({
        product: stringField(pair, 'product') ?? '',
        version: stringField(pair, 'version') ?? '',
      })),
  )
  const score = numberField(value, 'score') ?? 0
  if (!name || !valueDigest || (products.length === 0 && versions.length === 0)) {
    return undefined
  }
  return {
    source,
    name,
    valueDigest,
    products,
    versions,
    productVersionPairs,
    confidence: confidenceFromScore(score),
    score,
  }
}

function evidenceTargetMatches(target: TargetPlan, evidenceTarget: string | undefined): boolean {
  if (!evidenceTarget) return true
  const normalizedEvidenceUrl = normalizeUrl(evidenceTarget)
  const targetUrl = target.normalizedUrl ?? normalizeUrl(target.raw)
  if (normalizedEvidenceUrl && targetUrl) {
    return targetMatchesUrl(targetUrl, normalizedEvidenceUrl)
  }
  const evidenceHost = normalizeHost(evidenceTarget)
  const targetHost = target.normalizedHost ?? normalizeHost(target.raw)
  return evidenceHost === targetHost || hostMatchesDomain(targetHost, evidenceHost)
}

function confidenceLabel(value: string | undefined): ConfidenceLabel {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  return 'medium'
}

function ownerConfirmedVersionEvidence(
  scope: ScopeFile | undefined,
  target: TargetPlan,
): OwnerConfirmedVersionEvidence[] {
  const records = Array.isArray(scope?.technologyEvidence)
    ? scope.technologyEvidence
    : []
  const result: OwnerConfirmedVersionEvidence[] = []
  for (const record of records) {
    const source = record.source?.trim().toLowerCase() ?? ''
    if (!ownerConfirmedEvidenceSources.has(source)) continue
    const product = canonicalProductName(record.product ?? '')
    const version = record.version?.trim().toLowerCase()
    if (!product || !version) continue
    if (!evidenceTargetMatches(target, record.target)) continue
    const cpe23Name =
      normalizeCpe23Name(record.cpe23Name) ??
      normalizeCpe23Name(record.cpe) ??
      cpe23NameForProduct(product, version)
    result.push({
      product,
      vendor: record.vendor?.trim().toLowerCase(),
      version,
      cpe23Name,
      source,
      evidenceId: record.evidenceId,
      target: record.target,
      observedAt: record.observedAt,
      confidence: confidenceLabel(record.confidence),
      notes: list(record.notes),
    })
  }
  return result.sort((a, b) =>
    `${a.product}@${a.version}`.localeCompare(`${b.product}@${b.version}`),
  )
}

function extractFingerprintSummary(
  target: TargetPlan,
  baseline?: Record<string, unknown>,
  scope?: ScopeFile,
): FingerprintSummary {
  const headers = recordStringMap(baseline?.headers)
  const products = new Set<string>()
  const versions = new Set<string>()
  const observations: FingerprintObservation[] = []

  for (const name of fingerprintHeaderNames) {
    const value = headers[name]
    if (!value) continue
    const observation = fingerprintObservation(name, value)
    if (!observation) continue
    observations.push(observation)
    for (const product of observation.products) products.add(product)
    for (const version of observation.versions) versions.add(version)
  }

  const signalObservations = arrayField(
    recordField(baseline, 'fingerprintSignals'),
    'observations',
  )
    .map(fingerprintObservationFromRecord)
    .filter(
      (observation): observation is FingerprintObservation =>
        observation !== undefined,
    )
  for (const observation of signalObservations) {
    observations.push(observation)
    for (const product of observation.products) products.add(product)
    for (const version of observation.versions) versions.add(version)
  }

  const ownerEvidence = ownerConfirmedVersionEvidence(scope, target)
  for (const evidence of ownerEvidence) {
    products.add(evidence.product)
    versions.add(evidence.version)
  }

  const productList = uniqueSorted(products)
  const versionList = uniqueSorted(versions)
  const productVersionPairs = uniquePairs([
    ...observations.flatMap(observation => observation.productVersionPairs),
    ...ownerEvidence.map(evidence => ({
      product: evidence.product,
      version: evidence.version,
    })),
  ])
  const metadata = productMetadata(productList, versionList, ownerEvidence)
  const vendorHints = uniqueSorted([
    ...metadata.flatMap(item => item.vendors),
    ...ownerEvidence
      .map(item => item.vendor)
      .filter((item): item is string => Boolean(item)),
  ])
  const cpe23Names = uniqueSorted([
    ...metadata.flatMap(item => item.cpe23Names),
    ...ownerEvidence
      .map(item => item.cpe23Name)
      .filter((item): item is string => Boolean(item)),
  ])
  const bestObservationScore = Math.max(
    0,
    ...observations.map(observation => observation.score),
  )
  const confidenceScore = Math.min(
    100,
    bestObservationScore +
      Math.min(observations.length, 4) * 4 +
      Math.min(productVersionPairs.length, 3) * 6 +
      Math.min(ownerEvidence.length, 2) * 36 +
      Math.min(cpe23Names.length, 3) * 4,
  )
  return {
    target: target.normalizedUrl ?? target.raw,
    headers,
    products: productList,
    versions: versionList,
    productVersionPairs,
    vendorHints,
    cpe23Names,
    productMetadata: metadata,
    ownerConfirmedVersionEvidence: ownerEvidence,
    observations,
    matchTerms: uniqueSorted([...productList, ...versionList, ...vendorHints]),
    confidence: confidenceFromScore(confidenceScore),
    confidenceScore,
    evidenceNotes: [
      `fingerprint confidence ${confidenceFromScore(confidenceScore)} (${confidenceScore}/100)`,
      `${observations.length} header observation(s) produced product or version evidence`,
      `${productVersionPairs.length} product/version pair(s) were observed in the same header context`,
      `${ownerEvidence.length} owner-confirmed product/version evidence record(s) were available from scope`,
      `${cpe23Names.length} CPE 2.3 hint(s) were derived for advisory correlation`,
    ],
  }
}

async function readSourceState(): Promise<SourceState> {
  return (
    (await readJsonIfExists<SourceState>(
      resolveProjectPath(
        envPathFrom(
          ['REDSCOPE_TOOLS_SOURCE_STATE', 'REDSCOPE_SOURCE_STATE'],
          'tools/manifests/redscope-source-state.json',
        ),
      ),
    )) ?? { sources: {} }
  )
}

function extractCves(value: string): string[] {
  return uniqueSorted(
    (value.match(/\bCVE-\d{4}-\d{4,7}\b/gi) ?? []).map(item =>
      item.toUpperCase(),
    ),
  )
}

function matchedFingerprintProducts(
  haystack: string,
  fingerprints: FingerprintSummary,
): string[] {
  return fingerprints.products.filter(product =>
    productMatchTerms(product).some(term => containsTerm(haystack, term)),
  )
}

function matchedFingerprintPairs(
  haystack: string,
  fingerprints: FingerprintSummary,
): ProductVersionPair[] {
  return uniquePairs(
    fingerprints.productVersionPairs.filter(pair => {
      const productMatched = productMatchTerms(pair.product).some(term =>
        containsTerm(haystack, term),
      )
      return productMatched && containsTerm(haystack, pair.version)
    }),
  )
}

function matchedFingerprintVendors(
  haystack: string,
  fingerprints: FingerprintSummary,
): string[] {
  return fingerprints.vendorHints.filter(vendor => containsTerm(haystack, vendor))
}

function matchedFingerprintCpes(
  haystack: string,
  fingerprints: FingerprintSummary,
): string[] {
  const sourceCpes = extractCpe23Names(haystack)
  return uniqueSorted(
    fingerprints.cpe23Names.filter(fingerprintCpe =>
      sourceCpes.some(sourceCpe => cpeNamesMatch(fingerprintCpe, sourceCpe)),
    ),
  )
}

function candidateContextSignals(haystack: string): string[] {
  return pocContextSignals.filter(signal => containsTerm(haystack, signal))
}

function scorePocCandidate(
  sourceId: string,
  fingerprints: FingerprintSummary,
  matchedProducts: string[],
  matchedVersions: string[],
  matchedProductVersionPairs: ProductVersionPair[],
  matchedVendors: string[],
  matchedCpe23Names: string[],
  matchedCves: string[],
  contextSignals: string[],
  templateReview: TemplateReview,
  ownerConfirmedVersionMatched: boolean,
): number {
  const sourceTrust = sourceTrustScores[sourceId] ?? 6
  const score =
    sourceTrust +
    Math.min(matchedProducts.length, 3) * 14 +
    Math.min(matchedVersions.length, 2) * 18 +
    Math.min(matchedProductVersionPairs.length, 2) * 24 +
    Math.min(matchedVendors.length, 2) * 6 +
    Math.min(matchedCpe23Names.length, 2) * 18 +
    Math.min(matchedCves.length, 3) * 8 +
    Math.min(contextSignals.length, 3) * 4 +
    (templateReview.status === 'allowlisted-low-impact' ? 10 : 0) +
    (ownerConfirmedVersionMatched ? 18 : 0) +
    Math.round(fingerprints.confidenceScore * 0.18)
  const weakProductOnlyPenalty =
    matchedProducts.length > 0 &&
    matchedVersions.length === 0 &&
    matchedProductVersionPairs.length === 0 &&
    matchedCpe23Names.length === 0
      ? 16
      : 0
  return Math.max(0, Math.min(100, score - weakProductOnlyPenalty))
}

function ownerConfirmedVersionMatched(
  candidate: Pick<
    PocCandidate,
    | 'matchedProducts'
    | 'matchedVersions'
    | 'matchedProductVersionPairs'
    | 'matchedCpe23Names'
  >,
  fingerprints: FingerprintSummary,
): boolean {
  return fingerprints.ownerConfirmedVersionEvidence.some(evidence => {
    const product = canonicalProductName(evidence.product)
    const directPairMatched = candidate.matchedProductVersionPairs.some(
      pair =>
        canonicalProductName(pair.product) === product &&
        pair.version === evidence.version,
    )
    const separateTermsMatched =
      candidate.matchedProducts.some(item => canonicalProductName(item) === product) &&
      candidate.matchedVersions.includes(evidence.version)
    const cpeMatched =
      evidence.cpe23Name != null &&
      candidate.matchedCpe23Names.some(item => cpeNamesMatch(item, evidence.cpe23Name ?? ''))
    return directPairMatched || separateTermsMatched || cpeMatched
  })
}

function pocTriageStatus(
  score: number,
  matchedVersions: string[],
  matchedProductVersionPairs: ProductVersionPair[],
  matchedCpe23Names: string[],
  matchedCves: string[],
  templateReview: TemplateReview,
  hasOwnerConfirmedVersion: boolean,
): PocCandidate['triageStatus'] {
  const hasVersionEvidence =
    matchedVersions.length > 0 ||
    matchedProductVersionPairs.length > 0 ||
    matchedCpe23Names.length > 0 ||
    hasOwnerConfirmedVersion
  const hasHistoricalSignal =
    matchedCves.length > 0 || templateReview.status === 'allowlisted-low-impact'
  return score >= 60 && hasVersionEvidence && hasHistoricalSignal
    ? 'planned-validation'
    : 'triage-only'
}

function pocCandidateReason(
  candidate: Pick<
    PocCandidate,
    | 'matchedProducts'
    | 'matchedVersions'
    | 'matchedProductVersionPairs'
    | 'matchedCpe23Names'
    | 'matchedCves'
    | 'templateReview'
    | 'evidenceClass'
    | 'triageStatus'
  >,
): string {
  if (candidate.triageStatus === 'triage-only') {
    return 'candidate kept as triage-only because evidence is missing owner-confirmed version, CPE, CVE, or reviewed low-impact template correlation'
  }
  if (candidate.evidenceClass === 'owner-confirmed-target-version') {
    return 'owner-confirmed target product/version evidence matched historical vulnerability source content'
  }
  if (candidate.matchedCpe23Names.length > 0 && candidate.matchedCves.length > 0) {
    return 'CPE/vendor mapping and historical vulnerability identifier matched source content'
  }
  if (candidate.matchedProductVersionPairs.length > 0 && candidate.matchedCves.length > 0) {
    return 'product/version fingerprint and historical vulnerability identifier matched source content'
  }
  if (candidate.matchedVersions.length > 0 && candidate.matchedCves.length > 0) {
    return 'product, version, and CVE-style historical vulnerability evidence matched source content'
  }
  if (candidate.templateReview.status === 'allowlisted-low-impact') {
    return 'product and version fingerprint matched an allowlisted low-impact template source'
  }
  return 'candidate matched target fingerprint evidence but still requires manual triage'
}

function yamlScalar(haystack: string, key: string): string | undefined {
  const match = haystack.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*['"]?([^'"#\\n\\r]+)`, 'im'),
  )
  return match?.[1]?.trim().toLowerCase()
}

function yamlTags(haystack: string): string[] {
  const scalar = yamlScalar(haystack, 'tags')
  if (!scalar) return []
  return uniqueSorted(
    scalar
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean),
  )
}

function templateReview(
  sourceId: string,
  relativeSourcePath: string,
  haystack: string,
): TemplateReview {
  const templateId = yamlScalar(haystack, 'id')
  const severity = yamlScalar(haystack, 'severity')
  const tags = yamlTags(haystack)
  if (!reviewedTemplateSourceIds.has(sourceId)) {
    return {
      status: 'not-reviewed',
      sourceId,
      templateId,
      severity,
      tags,
      reasons: ['source is not in the reviewed-template allowlist'],
    }
  }

  const normalizedPath = relativeSourcePath.split('\\').join('/').toLowerCase()
  const pathAllowlisted = reviewedTemplatePathPrefixes.some(prefix =>
    normalizedPath.startsWith(prefix),
  )
  const severityAllowlisted = severity
    ? reviewedTemplateSeverities.has(severity)
    : false
  const rejectedTags = tags.filter(tag => rejectedTemplateTags.has(tag))
  const reasons: string[] = []
  if (pathAllowlisted) reasons.push('template path is in the reviewed low-impact allowlist')
  else reasons.push('template path is outside the reviewed low-impact allowlist')
  if (severityAllowlisted) reasons.push(`template severity is ${severity}`)
  else reasons.push(`template severity is ${severity ?? 'unknown'}`)
  if (rejectedTags.length > 0) {
    reasons.push(`template has rejected tag(s): ${rejectedTags.join(', ')}`)
  }

  return {
    status:
      pathAllowlisted && severityAllowlisted && rejectedTags.length === 0
        ? 'allowlisted-low-impact'
        : 'rejected',
    sourceId,
    templateId,
    severity,
    tags,
    reasons,
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSearchUrl(value: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function resolveBingSearchUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) return undefined
  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/)
  if (uMatch) {
    const encoded = uMatch[1]
    const b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      return normalizeSearchUrl(decoded)
    } catch {
      // Keep the direct URL fallback below.
    }
  }
  if (rawUrl.includes('bing.com')) return undefined
  return normalizeSearchUrl(rawUrl)
}

function resolveGoogleSearchUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl)
  if (decoded.startsWith('/url?')) {
    try {
      const url = new URL(`https://www.google.com${decoded}`)
      return normalizeSearchUrl(url.searchParams.get('q') ?? '')
    } catch {
      return undefined
    }
  }
  if (decoded.startsWith('/')) return undefined
  return normalizeSearchUrl(decoded)
}

function scoreExternalSearchResult(
  provider: ExternalPocSearchProvider,
  query: string,
  title: string,
  url: string,
  snippet: string | undefined,
  fingerprints: FingerprintSummary,
): ExternalPocSearchResult {
  const haystack = `${title}\n${url}\n${snippet ?? ''}`.toLowerCase()
  const matchedProducts = matchedFingerprintProducts(haystack, fingerprints)
  const matchedVendors = matchedFingerprintVendors(haystack, fingerprints)
  const matchedVersions = fingerprints.versions.filter(term =>
    containsTerm(haystack, term),
  )
  const matchedCves = extractCves(haystack)
  const providerScore =
    provider === 'github' ? 22 : provider === 'bing' ? 14 : 10
  const securitySignals = candidateContextSignals(haystack)
  const evidenceScore = Math.min(
    100,
    providerScore +
      Math.min(matchedProducts.length, 3) * 14 +
      Math.min(matchedVendors.length, 2) * 6 +
      Math.min(matchedVersions.length, 2) * 18 +
      Math.min(matchedCves.length, 3) * 10 +
      Math.min(securitySignals.length, 3) * 4 +
      Math.round(fingerprints.confidenceScore * 0.14),
  )
  return {
    provider,
    query,
    title,
    url,
    snippet,
    matchedProducts,
    matchedVendors,
    matchedVersions,
    matchedCves,
    evidenceScore,
    confidence: confidenceFromScore(evidenceScore),
    evidenceClass: 'public-intelligence-lead',
    notes: [
      'External search result is untrusted metadata and is not a confirmed vulnerability.',
      'Do not execute linked PoC code without a separate reviewed validation profile.',
    ],
  }
}

function buildExternalPocSearchQueries(
  fingerprints: FingerprintSummary,
  localCves: string[],
): string[] {
  const currentYear = new Date().getUTCFullYear()
  const queries: string[] = []

  for (const cve of localCves.slice(0, 4)) {
    queries.push(`${cve} PoC exploit GitHub`)
  }

  for (const pair of fingerprints.productVersionPairs.slice(0, 4)) {
    const vendors = productVendors(pair.product).slice(0, 1)
    const vendorPrefix = vendors.length > 0 ? `${vendors[0]} ` : ''
    queries.push(`${vendorPrefix}${pair.product} ${pair.version} CVE PoC GitHub`)
    queries.push(`${vendorPrefix}${pair.product} ${pair.version} vulnerability PoC ${currentYear}`)
  }

  for (const product of fingerprints.products.slice(0, 4)) {
    const versions = fingerprints.versions.slice(0, 2)
    const vendors = productVendors(product).slice(0, 1)
    const vendorPrefix = vendors.length > 0 ? `${vendors[0]} ` : ''
    if (versions.length === 0) {
      queries.push(`${vendorPrefix}${product} CVE PoC GitHub ${currentYear}`)
      continue
    }
    for (const version of versions) {
      queries.push(`${vendorPrefix}${product} ${version} CVE PoC`)
    }
  }

  return uniqueSorted(queries)
    .filter(query => !query.includes(fingerprints.target))
    .slice(0, externalPocSearchMaxQueries)
}

async function fetchTextWithTimeout(url: string, headers = externalSearchHeaders) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(externalPocSearchTimeoutMs),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text()
}

async function searchGithubPocs(
  query: string,
  fingerprints: FingerprintSummary,
): Promise<ExternalPocSearchResult[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=updated&order=desc&per_page=${externalPocSearchResultsPerProvider}`
  const response = await fetch(url, {
    headers: {
      ...externalSearchHeaders,
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(externalPocSearchTimeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as unknown
  const items = isRecord(data) && Array.isArray(data.items) ? data.items : []
  return items
    .filter(isRecord)
    .slice(0, externalPocSearchResultsPerProvider)
    .map(item =>
      scoreExternalSearchResult(
        'github',
        query,
        typeof item.full_name === 'string' ? item.full_name : 'GitHub result',
        typeof item.html_url === 'string' ? item.html_url : '',
        typeof item.description === 'string' ? item.description : undefined,
        fingerprints,
      ),
    )
    .filter(result => Boolean(normalizeSearchUrl(result.url)))
}

function htmlAnchorResults(
  provider: ExternalPocSearchProvider,
  query: string,
  html: string,
  fingerprints: FingerprintSummary,
  resolveUrl: (url: string) => string | undefined,
): ExternalPocSearchResult[] {
  const results: ExternalPocSearchResult[] = []
  const seen = new Set<string>()
  const anchorRegex = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = anchorRegex.exec(html)) !== null) {
    if (results.length >= externalPocSearchResultsPerProvider) break
    const url = resolveUrl(match[1])
    if (!url || seen.has(url)) continue
    if (/\/search[/?]|\/preferences|accounts\.google|support\.google/i.test(url)) {
      continue
    }
    seen.add(url)
    const title = stripHtml(match[2]) || url
    if (title.length < 3) continue
    results.push(
      scoreExternalSearchResult(
        provider,
        query,
        title.slice(0, 180),
        url,
        undefined,
        fingerprints,
      ),
    )
  }

  return results
}

async function searchBingPocs(
  query: string,
  fingerprints: FingerprintSummary,
): Promise<ExternalPocSearchResult[]> {
  const html = await fetchTextWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`,
  )
  return htmlAnchorResults('bing', query, html, fingerprints, resolveBingSearchUrl)
}

async function searchGooglePocs(
  query: string,
  fingerprints: FingerprintSummary,
): Promise<ExternalPocSearchResult[]> {
  const html = await fetchTextWithTimeout(
    `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`,
  )
  return htmlAnchorResults(
    'google',
    query,
    html,
    fingerprints,
    resolveGoogleSearchUrl,
  )
}

async function searchBaiduPocs(
  query: string,
  fingerprints: FingerprintSummary,
): Promise<ExternalPocSearchResult[]> {
  const html = await fetchTextWithTimeout(
    `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=10`,
  )
  return htmlAnchorResults('baidu', query, html, fingerprints, normalizeSearchUrl)
}

async function runExternalPocSearch(
  fingerprints: FingerprintSummary,
  localCves: string[],
): Promise<ExternalPocSearchSummary> {
  const queries = buildExternalPocSearchQueries(fingerprints, localCves)
  const providerResults: ExternalPocSearchProviderResult[] = []
  const errors: ExternalPocSearchSummary['errors'] = []
  const allResults: ExternalPocSearchResult[] = []

  if (queries.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: 'skipped',
      providers: externalPocSearchProviders,
      queryCount: 0,
      resultCount: 0,
      results: [],
      providerResults: [],
      errors: [],
      policy: externalSearchPolicy(),
    }
  }

  const searchTasks = externalPocSearchProviders.flatMap(provider =>
    queries.map(async query => {
      try {
        const results =
          provider === 'github'
            ? await searchGithubPocs(query, fingerprints)
            : provider === 'bing'
              ? await searchBingPocs(query, fingerprints)
              : provider === 'google'
              ? await searchGooglePocs(query, fingerprints)
              : await searchBaiduPocs(query, fingerprints)
        return {
          providerResult: {
            provider,
            query,
            status: 'completed' as const,
            resultCount: results.length,
            results,
          },
          results,
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          providerResult: {
            provider,
            query,
            status: 'failed' as const,
            resultCount: 0,
            results: [],
            reason,
          },
          results: [],
          error: { provider, query, reason },
        }
      }
    }),
  )

  for (const result of await Promise.all(searchTasks)) {
    providerResults.push(result.providerResult)
    allResults.push(...result.results)
    if (result.error) errors.push(result.error)
  }

  const seen = new Set<string>()
  const results = allResults
    .sort((a, b) => b.evidenceScore - a.evidenceScore)
    .filter(result => {
      const normalized = normalizeSearchUrl(result.url)
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .slice(0, 50)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'completed',
    providers: externalPocSearchProviders,
    queryCount: queries.length,
    resultCount: results.length,
    results,
    providerResults,
    errors,
    policy: externalSearchPolicy(),
  }
}

function externalSearchPolicy(): ExternalPocSearchSummary['policy'] {
  return {
    targetHostIncludedInQueries: false,
    arbitraryPocExecutionAllowed: false,
    downloadsAllowed: false,
    notes: [
      'Queries use product, version, and CVE fingerprint terms only; target hostnames are not included.',
      'Search results are untrusted metadata for analyst review.',
      'RedScope does not download, run, or import PoC code from external search results.',
    ],
  }
}

function lowImpactValidationPolicy(): LowImpactValidationSummary['policy'] {
  return {
    arbitraryPocExecutionAllowed: false,
    allowedRequestMethods: ['GET', 'HEAD'],
    maxRequestsPerValidator: 1,
    requestBodyAllowed: false,
    rawBodyStored: false,
    notes: [
      'Low-impact validators are scope-declared and approval-gated.',
      'Each validator performs at most one same-origin GET or HEAD request with no request body.',
      'Only response metadata, header digests, body sample hashes, and assertion outcomes are stored.',
      'A target-verified issue requires a passing low-impact assertion against the scoped target.',
    ],
  }
}

function businessLogicValidationPolicy(): BusinessLogicValidationSummary['policy'] {
  return {
    arbitraryPocExecutionAllowed: false,
    defaultNetworkMode: 'safe-readonly-http',
    mutatingRequestsAllowedByDefault: false,
    paymentCaptureAllowed: false,
    destructiveUploadAllowed: false,
    rawBodyStored: false,
    secretHeaderStored: false,
    notes: [
      'Business-logic validation is scope-declared and separately approval-gated.',
      'safe-readonly-http test cases use only same-origin GET or HEAD requests with actor sessions supplied from environment variables or same-origin login bootstrap.',
      'Login bootstrap sends credentials only from environment variables, stores only session digests, and never writes raw account secrets, cookies, or bearer tokens to artifacts.',
      'Payment, refund, coupon, upload, SQL injection, and other state-changing checks stay evidence-only unless a separate reviewed runner is added.',
      'Independent test families are emitted as parallel work lanes for analyst/subagent review; RedScope does not run intrusive payloads by default.',
      'A target-verified issue requires either a safe read-only authorization bypass proof or approved manual evidence that records verified target impact.',
    ],
  }
}

function statefulBusinessLogicValidationPolicy(
  scope: ScopeFile,
): BusinessLogicValidationSummary['policy'] {
  return {
    arbitraryPocExecutionAllowed: false,
    defaultNetworkMode: 'approved-state-changing-http',
    mutatingRequestsAllowedByDefault: true,
    approvedMutatingHttpAllowed: true,
    maxMutatingRequests:
      scope.logicValidation?.stateChangingApproval?.maxMutatingRequests ?? 1,
    paymentCaptureAllowed: false,
    destructiveUploadAllowed: false,
    rawBodyStored: false,
    secretHeaderStored: false,
    notes: [
      'State-changing business-logic validation is a separate active profile and requires explicit stateChangingApproval metadata.',
      'Only fixed, scope-declared same-origin POST/PUT/PATCH/DELETE requests are allowed; no fuzzing, brute force, arbitrary PoC code, or raw SQL payload generation is performed.',
      'Actor sessions can come from environment variables or same-origin login bootstrap and are kept run-local with only digests persisted.',
      'Request bodies are supplied from reviewed scope data or approved environment variables; RedScope stores only request-body digests.',
      'Target-verified promotion still requires observedImpact=true and approved evidence references after the mutating request.',
      ...list(scope.logicValidation?.stateChangingApproval?.notes),
    ],
  }
}

function businessLogicMode(value: string | undefined): BusinessLogicValidationMode {
  if (
    value === 'safe-readonly-http' ||
    value === 'approved-state-changing-http' ||
    value === 'evidence-only' ||
    value === 'manual-review'
  ) {
    return value
  }
  return 'manual-review'
}

function businessLogicCategory(value: string | undefined): BusinessLogicTestCategory {
  if (
    value === 'horizontal-authorization' ||
    value === 'vertical-authorization' ||
    value === 'idor' ||
    value === 'payment-flow' ||
    value === 'refund-flow' ||
    value === 'coupon-abuse' ||
    value === 'workflow-state' ||
    value === 'file-upload' ||
    value === 'sql-injection' ||
    value === 'business-logic' ||
    value === 'other'
  ) {
    return value
  }
  return 'business-logic'
}

function businessLogicSeverity(
  value: string | undefined,
): BusinessLogicValidationRecord['severity'] {
  if (
    value === 'critical' ||
    value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'info'
  ) {
    return value
  }
  return 'medium'
}

function businessLogicTestId(index: number, rawId: string | undefined): string {
  const normalized = rawId?.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  return normalized || `logic-test-${index + 1}`
}

function businessLogicRequestMethod(value: string | undefined): 'GET' | 'HEAD' | undefined {
  const upper = value?.trim().toUpperCase()
  if (!upper || upper === 'GET') return 'GET'
  if (upper === 'HEAD') return 'HEAD'
  return undefined
}

function statefulBusinessLogicRequestMethod(
  value: string | undefined,
): Exclude<BusinessLogicHttpMethod, 'GET' | 'HEAD'> | undefined {
  const upper = value?.trim().toUpperCase()
  if (
    upper === 'POST' ||
    upper === 'PUT' ||
    upper === 'PATCH' ||
    upper === 'DELETE'
  ) {
    return upper
  }
  return undefined
}

function statefulRequestContentType(
  value: string | undefined,
): 'json' | 'form' | 'text' | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'json') return 'json'
  if (normalized === 'form') return 'form'
  if (normalized === 'text') return 'text'
  return undefined
}

function statusList(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback
  const statuses = value.filter(
    item => Number.isInteger(item) && item >= 100 && item <= 599,
  ) as number[]
  return statuses.length > 0 ? statuses : fallback
}

function statusAllowed(status: number | undefined, statuses: number[]): boolean {
  return status != null && statuses.includes(status)
}

function scopedBusinessLogicUrl(
  target: TargetPlan,
  testCase: NonNullable<ScopeFile['logicValidation']>['testCases'][number],
): string | undefined {
  const baseRaw = target.normalizedUrl ?? normalizeUrl(target.raw)
  if (!baseRaw) return undefined
  try {
    const base = new URL(baseRaw)
    const rawPath = testCase.path?.trim() || '/'
    const candidateUrl = new URL(rawPath, base)
    candidateUrl.hash = ''
    if (candidateUrl.origin !== base.origin) return undefined
    if (!targetMatchesUrl(candidateUrl.toString(), base.toString())) return undefined
    if (!evidenceTargetMatches(target, testCase.target)) return undefined
    return candidateUrl.toString()
  } catch {
    return undefined
  }
}

function actorId(
  actor: NonNullable<ScopeFile['logicValidation']>['actorSessions'][number],
  index: number,
): string {
  const normalized = actor.id?.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  return normalized || `actor-${index + 1}`
}

function actorSessionGuidance(
  id: string,
  actor: NonNullable<ScopeFile['logicValidation']>['actorSessions'][number],
): string[] {
  const guidance: string[] = []
  if (actor.headerEnv?.trim()) {
    guidance.push(
      `Set ${actor.headerEnv.trim()} to the approved ${actor.headerName ?? 'Authorization'} header value for actor ${id}.`,
    )
  } else {
    guidance.push(
      `Declare logicValidation.actorSessions[].headerEnv for actor ${id} so RedScope can attach the approved session header.`,
    )
  }
  if (actor.login) {
    guidance.push(
      'Check the actor login configuration, credential environment variables, allowed same-origin login URL, success statuses, tokenJsonPath, or cookieNames.',
    )
  } else {
    guidance.push(
      'Alternatively add an actor login configuration that uses usernameEnv/passwordEnv and extracts a token or Cookie header during the approved test window.',
    )
  }
  return guidance
}

function scopedActorLoginUrl(
  target: TargetPlan,
  login: NonNullable<
    NonNullable<ScopeFile['logicValidation']>['actorSessions'][number]['login']
  >,
): string | undefined {
  const baseRaw = target.normalizedUrl ?? normalizeUrl(target.raw)
  if (!baseRaw) return undefined
  const rawLoginUrl = login.url?.trim() || login.path?.trim()
  if (!rawLoginUrl) return undefined
  try {
    const base = new URL(baseRaw)
    const candidateUrl = new URL(rawLoginUrl, base)
    candidateUrl.hash = ''
    if (candidateUrl.origin !== base.origin) return undefined
    return candidateUrl.toString()
  } catch {
    return undefined
  }
}

function businessLogicLoginMethod(value: string | undefined): 'POST' | undefined {
  const method = value?.trim().toUpperCase() || 'POST'
  return method === 'POST' ? 'POST' : undefined
}

function businessLogicLoginContentType(
  value: string | undefined,
): 'form' | 'json' | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'form') return 'form'
  if (normalized === 'json') return 'json'
  return undefined
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

type StatefulRequestBodyMaterial = {
  body?: string
  contentType?: string
  sha256?: string
  source: 'none' | 'scope' | 'environment'
  error?: string
}

function stringifiableRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      result[key] = String(item)
      continue
    }
    return undefined
  }
  return result
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function statefulRequestBodyMaterial(
  testCase: NonNullable<ScopeFile['logicValidation']>['testCases'][number],
): StatefulRequestBodyMaterial {
  const envName = testCase.requestBodyEnv?.trim()
  const contentType = statefulRequestContentType(testCase.requestContentType)
  if (!contentType) {
    return {
      source: 'none',
      error: 'requestContentType must be json, form, or text',
    }
  }

  let body: string | undefined
  let source: StatefulRequestBodyMaterial['source'] = 'none'
  if (envName) {
    body = process.env[envName]
    source = 'environment'
    if (body == null) {
      return {
        source,
        error: `requestBodyEnv ${envName} is not set`,
      }
    }
  } else if (testCase.requestBody != null) {
    source = 'scope'
    if (contentType === 'json') {
      body = JSON.stringify(testCase.requestBody)
    } else if (contentType === 'form') {
      const fields = stringifiableRecord(testCase.requestBody)
      if (!fields) {
        return {
          source,
          error:
            'form requestBody must be an object containing only string, number, or boolean values',
        }
      }
      body = new URLSearchParams(fields).toString()
    } else if (typeof testCase.requestBody === 'string') {
      body = testCase.requestBody
    } else {
      return {
        source,
        error: 'text requestBody must be a string',
      }
    }
  }

  const sha256 = body == null ? undefined : sha256Text(body)
  const expectedSha256 = testCase.requestBodySha256?.trim().toLowerCase()
  if (expectedSha256 && sha256 !== expectedSha256) {
    return {
      source,
      sha256,
      error: 'requestBodySha256 does not match the prepared request body',
    }
  }

  const header =
    body == null
      ? undefined
      : contentType === 'json'
        ? 'application/json'
        : contentType === 'form'
          ? 'application/x-www-form-urlencoded'
          : 'text/plain'
  return { body, contentType: header, sha256, source }
}

function tokenAtJsonPath(root: unknown, path: string): string | undefined {
  const parts = path
    .split('.')
    .map(item => item.trim())
    .filter(Boolean)
  if (parts.length === 0) return undefined
  let cursor: unknown = root
  for (const part of parts) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[part]
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map(item => item.trim())
    .filter(Boolean)
}

function cookiePairFromSetCookie(value: string): string | undefined {
  const pair = value.split(';', 1)[0]?.trim()
  if (!pair || !/^[A-Za-z0-9_.-]+=/.test(pair)) return undefined
  return pair
}

function cookieNameFromPair(pair: string): string {
  return pair.split('=', 1)[0].toLowerCase()
}

function cookieHeaderFromResponse(
  headers: Headers,
  cookieNames: string[],
): string | undefined {
  const allowed = new Set(cookieNames.map(item => item.toLowerCase()))
  const pairs: string[] = []
  for (const headerValue of setCookieHeaderValues(headers)) {
    for (const cookieValue of splitSetCookieHeader(headerValue)) {
      const pair = cookiePairFromSetCookie(cookieValue)
      if (!pair) continue
      if (allowed.size > 0 && !allowed.has(cookieNameFromPair(pair))) continue
      pairs.push(pair)
    }
  }
  return pairs.length > 0 ? uniqueSorted(pairs).join('; ') : undefined
}

async function loginBusinessLogicActorSession(
  id: string,
  actor: NonNullable<ScopeFile['logicValidation']>['actorSessions'][number],
  target: TargetPlan,
): Promise<BusinessLogicActorSessionMaterial> {
  const login = actor.login
  const guidance = actorSessionGuidance(id, actor)
  if (!login) {
    return {
      id,
      headerConfigured: false,
      source: 'missing',
      error: 'actor session is not configured',
      guidance,
    }
  }

  const loginUrl = scopedActorLoginUrl(target, login)
  if (!loginUrl) {
    return {
      id,
      headerConfigured: false,
      source: 'login-failed',
      error: 'actor login URL is missing or outside the scoped target origin',
      guidance,
    }
  }

  const method = businessLogicLoginMethod(login.method)
  if (!method) {
    return {
      id,
      headerConfigured: false,
      source: 'login-failed',
      error: 'actor login supports only POST to avoid credential leakage in URLs',
      guidance,
    }
  }

  const contentType = businessLogicLoginContentType(login.contentType)
  if (!contentType) {
    return {
      id,
      headerConfigured: false,
      source: 'login-failed',
      error: 'actor login contentType must be form or json',
      guidance,
    }
  }

  const usernameEnv = login.usernameEnv?.trim()
  const passwordEnv = login.passwordEnv?.trim()
  const username = usernameEnv ? process.env[usernameEnv] : undefined
  const password = passwordEnv ? process.env[passwordEnv] : undefined
  if (!usernameEnv || !passwordEnv || !username || !password) {
    return {
      id,
      headerConfigured: false,
      source: 'login-failed',
      error:
        'actor login credential environment variables are missing or unset',
      guidance,
    }
  }

  const usernameField = login.usernameField?.trim() || 'username'
  const passwordField = login.passwordField?.trim() || 'password'
  const payload: Record<string, string> = {
    ...stringRecord(login.extraFields),
    [usernameField]: username,
    [passwordField]: password,
  }
  const body =
    contentType === 'json'
      ? JSON.stringify(payload)
      : new URLSearchParams(payload).toString()
  const requestContentType =
    contentType === 'json'
      ? 'application/json'
      : 'application/x-www-form-urlencoded'

  try {
    const response = await fetch(loginUrl, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'RedScope-AI-Actor-Session-Bootstrap',
        Accept: 'application/json, text/html;q=0.8, */*;q=0.5',
        'Content-Type': requestContentType,
      },
      body,
    })
    const successStatuses = statusList(
      login.successStatuses,
      [200, 201, 202, 204, 302, 303],
    )
    if (!statusAllowed(response.status, successStatuses)) {
      return {
        id,
        headerConfigured: false,
        source: 'login-failed',
        error: `actor login returned unexpected HTTP ${response.status}`,
        guidance,
      }
    }

    if (login.tokenJsonPath?.trim()) {
      let json: unknown
      try {
        json = await response.json()
      } catch {
        return {
          id,
          headerConfigured: false,
          source: 'login-failed',
          error: 'actor login response was not valid JSON for token extraction',
          guidance,
        }
      }
      const token = tokenAtJsonPath(json, login.tokenJsonPath)
      if (!token) {
        return {
          id,
          headerConfigured: false,
          source: 'login-failed',
          error: `actor login response did not include tokenJsonPath ${login.tokenJsonPath}`,
          guidance,
        }
      }
      const prefix =
        login.tokenPrefix == null ? 'Bearer' : login.tokenPrefix.trim()
      const headerValue = prefix ? `${prefix} ${token}` : token
      return {
        id,
        headerName: actor.headerName?.trim() || 'Authorization',
        headerValue,
        headerConfigured: true,
        headerDigest: shortDigest(headerValue),
        source: 'login-token',
        guidance,
      }
    }

    const cookieHeader = cookieHeaderFromResponse(
      response.headers,
      list(login.cookieNames),
    )
    if (!cookieHeader) {
      return {
        id,
        headerConfigured: false,
        source: 'login-failed',
        error:
          'actor login did not return matching cookies and no tokenJsonPath was configured',
        guidance,
      }
    }
    return {
      id,
      headerName: actor.headerName?.trim() || 'Cookie',
      headerValue: cookieHeader,
      headerConfigured: true,
      headerDigest: shortDigest(cookieHeader),
      source: 'login-cookie',
      guidance,
    }
  } catch (error) {
    return {
      id,
      headerConfigured: false,
      source: 'login-failed',
      error: error instanceof Error ? error.message : String(error),
      guidance,
    }
  }
}

async function resolveBusinessLogicActorSessions(
  scope: ScopeFile,
  target: TargetPlan,
): Promise<Map<string, BusinessLogicActorSessionMaterial>> {
  const actors = Array.isArray(scope.logicValidation?.actorSessions)
    ? scope.logicValidation.actorSessions
    : []
  const sessions = new Map<string, BusinessLogicActorSessionMaterial>()
  for (const [index, actor] of actors.entries()) {
    const id = actorId(actor, index)
    const headerEnv = actor.headerEnv?.trim()
    const envValue = headerEnv ? process.env[headerEnv] : undefined
    if (envValue) {
      sessions.set(id, {
        id,
        headerName: actor.headerName?.trim() || 'Authorization',
        headerValue: envValue,
        headerConfigured: true,
        headerDigest: shortDigest(envValue),
        source: 'environment',
        guidance: actorSessionGuidance(id, actor),
      })
      continue
    }
    sessions.set(id, await loginBusinessLogicActorSession(id, actor, target))
  }
  return sessions
}

function actorSessionFailure(
  id: string,
  actor: NonNullable<ScopeFile['logicValidation']>['actorSessions'][number],
  session: BusinessLogicActorSessionMaterial | undefined,
): string {
  const reason = session?.error ?? 'actor session is not configured'
  const guidance = (session?.guidance ?? actorSessionGuidance(id, actor)).join(
    ' ',
  )
  return `${reason}. ${guidance}`
}

function buildBusinessLogicActors(
  scope: ScopeFile,
  sessions: Map<string, BusinessLogicActorSessionMaterial>,
): {
  actors: BusinessLogicActorRecord[]
  actorById: Map<string, NonNullable<ScopeFile['logicValidation']>['actorSessions'][number]>
} {
  const actorById = new Map<
    string,
    NonNullable<ScopeFile['logicValidation']>['actorSessions'][number]
  >()
  const actors = Array.isArray(scope.logicValidation?.actorSessions)
    ? scope.logicValidation.actorSessions
    : []
  const records: BusinessLogicActorRecord[] = []
  for (const [index, actor] of actors.entries()) {
    const id = actorId(actor, index)
    actorById.set(id, actor)
    const session = sessions.get(id)
    records.push({
      id,
      role: actor.role,
      headerName:
        session?.headerName ??
        actor.headerName ??
        (actor.headerEnv ? 'Authorization' : undefined),
      headerConfigured: session?.headerConfigured ?? false,
      headerDigest: session?.headerDigest,
      headerSource: session?.source,
      sessionError: session?.error,
      sessionGuidance: session?.guidance ?? actorSessionGuidance(id, actor),
      notes: list(actor.notes),
    })
  }
  return { actors: records, actorById }
}

function actorHeaders(
  actor: NonNullable<ScopeFile['logicValidation']>['actorSessions'][number],
  session: BusinessLogicActorSessionMaterial | undefined,
): Record<string, string> | undefined {
  const value =
    session?.headerValue ??
    (actor.headerEnv?.trim() ? process.env[actor.headerEnv.trim()] : undefined)
  if (!value) return undefined
  const headerName =
    session?.headerName ?? actor.headerName?.trim() ?? 'Authorization'
  return { [headerName]: value }
}

function failedBusinessLogicRecord(
  testCase: NonNullable<ScopeFile['logicValidation']>['testCases'][number],
  index: number,
  target: TargetPlan,
  reason: string,
): BusinessLogicValidationRecord {
  const id = businessLogicTestId(index, testCase.id)
  const approvedBy = testCase.approvedBy ?? 'missing'
  const approvalReference = testCase.approvalReference ?? 'missing'
  return {
    id,
    title: testCase.title ?? id,
    category: businessLogicCategory(testCase.category),
    validationMode: businessLogicMode(testCase.validationMode),
    target: target.normalizedUrl ?? target.raw,
    approval: { approvedBy, approvalReference },
    actors: {
      controlActor: testCase.controlActor,
      testActor: testCase.testActor,
      objectOwnerActor: testCase.objectOwnerActor,
    },
    affectedObject: testCase.affectedObject,
    status: 'skipped',
    impactVerified: false,
    severity: businessLogicSeverity(testCase.severity),
    evidence: [],
    requestEvidence: [],
    manualEvidenceRefs: list(testCase.evidenceRefs),
    expectedOutcome: testCase.expectedOutcome,
    observedOutcome: testCase.observedOutcome,
    impact:
      testCase.impact ??
      'No business-logic impact was verified because the test case did not run.',
    remediation:
      testCase.remediation ??
      'Fix the business-logic test configuration and rerun inside the authorized scope.',
    references: list(testCase.references),
    cweIds: list(testCase.cweIds),
    notes: [...list(testCase.notes), reason],
    parallelGroup: testCase.parallelGroup,
    isolatedTestFamily: testCase.isolatedTestFamily,
    error: reason,
  }
}

async function executeBusinessLogicActorRequest(
  actorIdValue: string,
  actor:
    | NonNullable<ScopeFile['logicValidation']>['actorSessions'][number]
    | undefined,
  session: BusinessLogicActorSessionMaterial | undefined,
  method: BusinessLogicHttpMethod,
  url: string,
  marker: string | undefined,
): Promise<BusinessLogicRequestEvidence> {
  if (!actor) {
    return {
      actorId: actorIdValue,
      method,
      url,
      rawBodyStored: false,
      headerValueStored: false,
      error: 'actor is not declared in logicValidation.actorSessions',
    }
  }

  const headers = actorHeaders(actor, session)
  if (!headers) {
    return {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      rawBodyStored: false,
      headerValueStored: false,
      error: actorSessionFailure(actorIdValue, actor, session),
    }
  }

  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'RedScope-AI-Business-Logic-Validator',
        Accept: '*/*',
        ...headers,
      },
    })
    const evidence: BusinessLogicRequestEvidence = {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      rawBodyStored: false,
      headerValueStored: false,
    }
    if (method === 'GET' && marker?.trim()) {
      const bodySample = await readResponseBodySample(
        response,
        lowImpactValidatorBodySampleBytes,
      )
      evidence.bodySampleSha256 = bodySample.sha256
      evidence.bodySampledBytes = bodySample.sampledBytes
      evidence.bodySampleTruncated = bodySample.truncated
      evidence.bodyMarkerDigest = shortDigest(marker)
      evidence.bodyMarkerMatched = bodySample.text
        .toLowerCase()
        .includes(marker.toLowerCase())
    }
    return evidence
  } catch (error) {
    return {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      rawBodyStored: false,
      headerValueStored: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function executeStatefulBusinessLogicActorRequest(
  actorIdValue: string,
  actor:
    | NonNullable<ScopeFile['logicValidation']>['actorSessions'][number]
    | undefined,
  session: BusinessLogicActorSessionMaterial | undefined,
  method: Exclude<BusinessLogicHttpMethod, 'GET' | 'HEAD'>,
  url: string,
  requestBody: StatefulRequestBodyMaterial,
  marker: string | undefined,
): Promise<BusinessLogicRequestEvidence> {
  if (!actor) {
    return {
      actorId: actorIdValue,
      method,
      url,
      requestBodySha256: requestBody.sha256,
      requestBodyStored: false,
      rawBodyStored: false,
      headerValueStored: false,
      error: 'actor is not declared in logicValidation.actorSessions',
    }
  }

  const headers = actorHeaders(actor, session)
  if (!headers) {
    return {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      requestBodySha256: requestBody.sha256,
      requestBodyStored: false,
      rawBodyStored: false,
      headerValueStored: false,
      error: actorSessionFailure(actorIdValue, actor, session),
    }
  }

  try {
    const requestHeaders: Record<string, string> = {
      'User-Agent': 'RedScope-AI-Stateful-Business-Logic-Validator',
      Accept: '*/*',
      ...headers,
    }
    if (requestBody.contentType && requestBody.body != null) {
      requestHeaders['Content-Type'] = requestBody.contentType
    }

    const response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: requestHeaders,
      body: requestBody.body,
    })
    const evidence: BusinessLogicRequestEvidence = {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      requestBodySha256: requestBody.sha256,
      requestBodyStored: false,
      rawBodyStored: false,
      headerValueStored: false,
    }
    if (marker?.trim()) {
      const bodySample = await readResponseBodySample(
        response,
        lowImpactValidatorBodySampleBytes,
      )
      evidence.bodySampleSha256 = bodySample.sha256
      evidence.bodySampledBytes = bodySample.sampledBytes
      evidence.bodySampleTruncated = bodySample.truncated
      evidence.bodyMarkerDigest = shortDigest(marker)
      evidence.bodyMarkerMatched = bodySample.text
        .toLowerCase()
        .includes(marker.toLowerCase())
    }
    return evidence
  } catch (error) {
    return {
      actorId: actorIdValue,
      role: actor.role,
      method,
      url,
      requestBodySha256: requestBody.sha256,
      requestBodyStored: false,
      rawBodyStored: false,
      headerValueStored: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildParallelExecutionPlan(
  testCases: NonNullable<ScopeFile['logicValidation']>['testCases'],
): BusinessLogicValidationSummary['parallelExecutionPlan'] {
  const groups = new Map<
    string,
    {
      families: Set<string>
      ids: string[]
    }
  >()
  for (const [index, testCase] of testCases.entries()) {
    const category = businessLogicCategory(testCase.category)
    const family = testCase.isolatedTestFamily ?? category
    const groupId = testCase.parallelGroup ?? family
    const group = groups.get(groupId) ?? { families: new Set<string>(), ids: [] }
    group.families.add(family)
    group.ids.push(businessLogicTestId(index, testCase.id))
    groups.set(groupId, group)
  }

  const statefulFamilies = new Set([
    'payment-flow',
    'refund-flow',
    'coupon-abuse',
    'workflow-state',
  ])

  return Array.from(groups.entries()).map(([groupId, group]) => {
    const families = Array.from(group.families).sort()
    const canRunInParallel = families.every(family => !statefulFamilies.has(family))
    return {
      groupId,
      isolatedTestFamilies: families,
      testCaseIds: group.ids,
      canRunInParallel,
      notes: canRunInParallel
        ? [
            'This lane is non-stateful by default and can be assigned to a separate analyst/subagent after confirming no shared target state.',
            'Run test cases within the lane sequentially when they share actors, objects, or credentials.',
          ]
        : [
            'This lane may change business state or depend on workflow ordering; keep it serial and manually supervised.',
            'Payment, refund, coupon, and workflow-state checks require explicit owner evidence before promotion.',
          ],
    }
  })
}

function lowImpactMethod(value: string | undefined): LowImpactValidationMethod | undefined {
  if (
    value === 'http-status' ||
    value === 'http-header-present' ||
    value === 'http-header-absent' ||
    value === 'http-header-value-contains' ||
    value === 'http-body-marker'
  ) {
    return value
  }
  return undefined
}

function lowImpactSeverity(value: string | undefined): LowImpactValidatorRecord['severity'] {
  if (value === 'medium' || value === 'low' || value === 'info') return value
  return 'low'
}

function lowImpactRequestMethod(
  method: LowImpactValidationMethod,
  requestMethod: string | undefined,
): 'GET' | 'HEAD' {
  if (method === 'http-body-marker') return 'GET'
  return requestMethod?.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
}

function scopedValidatorUrl(
  target: TargetPlan,
  validator: NonNullable<ScopeFile['validation']>['validators'][number],
): string | undefined {
  const baseRaw = target.normalizedUrl ?? normalizeUrl(target.raw)
  if (!baseRaw) return undefined
  try {
    const base = new URL(baseRaw)
    const rawPath = validator.path?.trim() || '/'
    const candidateUrl = new URL(rawPath, base)
    candidateUrl.hash = ''
    if (candidateUrl.origin !== base.origin) return undefined
    if (!targetMatchesUrl(candidateUrl.toString(), base.toString())) return undefined
    if (!evidenceTargetMatches(target, validator.target)) return undefined
    return candidateUrl.toString()
  } catch {
    return undefined
  }
}

function lowImpactValidatorId(index: number, rawId: string | undefined): string {
  const normalized = rawId?.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  return normalized || `validator-${index + 1}`
}

function failedLowImpactRecord(
  validator: NonNullable<ScopeFile['validation']>['validators'][number],
  index: number,
  target: TargetPlan,
  reason: string,
): LowImpactValidatorRecord {
  const id = lowImpactValidatorId(index, validator.id)
  const approvedBy = validator.approvedBy ?? 'missing'
  const approvalReference = validator.approvalReference ?? 'missing'
  return {
    id,
    title: validator.title ?? id,
    method: lowImpactMethod(validator.method) ?? 'http-status',
    target: target.normalizedUrl ?? target.raw,
    request: {
      method: 'GET',
      url: target.normalizedUrl ?? target.raw,
      redirect: 'manual',
      bodySent: false,
    },
    approval: { approvedBy, approvalReference },
    status: 'skipped',
    impactVerified: false,
    severity: lowImpactSeverity(validator.severity),
    category: validator.category ?? 'low-impact-validation',
    evidence: [],
    responseEvidence: { rawBodyStored: false },
    impact:
      validator.impact ??
      'No target impact was verified because the validator did not run.',
    remediation:
      validator.remediation ??
      'Fix the validator configuration and rerun only inside the authorized scope.',
    references: list(validator.references),
    candidateCves: list(validator.candidateCves).map(item => item.toUpperCase()),
    cpe23Names: list(validator.cpe23Names),
    notes: [...list(validator.notes), reason],
    error: reason,
  }
}

function evaluateLowImpactValidator(
  validator: NonNullable<ScopeFile['validation']>['validators'][number],
  method: LowImpactValidationMethod,
  response: Response,
  bodySample:
    | Awaited<ReturnType<typeof readResponseBodySample>>
    | undefined,
): Pick<
  LowImpactValidatorRecord,
  'status' | 'impactVerified' | 'evidence' | 'responseEvidence'
> {
  const evidence: string[] = [`HTTP response status ${response.status}`]
  const headerName = validator.header?.trim().toLowerCase()
  const headerValue = headerName ? response.headers.get(headerName) : null
  const responseEvidence: LowImpactValidatorRecord['responseEvidence'] = {
    status: response.status,
    statusText: response.statusText,
    rawBodyStored: false,
  }

  if (headerName) {
    responseEvidence.headerName = headerName
    responseEvidence.headerPresent = headerValue != null
    if (headerValue != null) {
      responseEvidence.headerValueDigest = shortDigest(headerValue)
    }
  }
  if (bodySample) {
    responseEvidence.bodySampleSha256 = bodySample.sha256
    responseEvidence.bodySampledBytes = bodySample.sampledBytes
    responseEvidence.bodySampleTruncated = bodySample.truncated
  }

  let passed = false
  if (method === 'http-status') {
    passed = response.status === validator.expectedStatus
    evidence.push(
      `Expected status ${validator.expectedStatus}; observed ${response.status}`,
    )
  } else if (method === 'http-header-present') {
    passed = Boolean(headerName && headerValue != null)
    evidence.push(
      headerName
        ? `Header ${headerName} ${passed ? 'was present' : 'was not present'}`
        : 'Header name was missing',
    )
  } else if (method === 'http-header-absent') {
    passed = Boolean(headerName && headerValue == null)
    evidence.push(
      headerName
        ? `Header ${headerName} ${passed ? 'was absent' : 'was present'}`
        : 'Header name was missing',
    )
  } else if (method === 'http-header-value-contains') {
    const expected = validator.expected?.trim()
    responseEvidence.expectedValueDigest = expected
      ? shortDigest(expected)
      : undefined
    passed = Boolean(
      headerName &&
        expected &&
        headerValue?.toLowerCase().includes(expected.toLowerCase()),
    )
    evidence.push(
      headerName
        ? `Header ${headerName} ${passed ? 'matched' : 'did not match'} the approved value marker digest`
        : 'Header name was missing',
    )
  } else {
    const marker = validator.expected?.trim()
    responseEvidence.bodyMarkerDigest = marker ? shortDigest(marker) : undefined
    responseEvidence.bodyMarkerMatched = Boolean(
      marker && bodySample?.text.toLowerCase().includes(marker.toLowerCase()),
    )
    passed = responseEvidence.bodyMarkerMatched === true
    evidence.push(
      passed
        ? 'Bounded body sample matched the approved marker digest'
        : 'Bounded body sample did not match the approved marker digest',
    )
  }

  return {
    status: passed ? 'verified' : 'not-verified',
    impactVerified: passed,
    evidence,
    responseEvidence,
  }
}

async function runLowImpactValidatorStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
  scope: ScopeFile,
): Promise<PlannedCommand> {
  const outputDir = join(runDir, 'raw')
  const outputPath = join(outputDir, 'low-impact-validation.json')
  await mkdir(outputDir, { recursive: true })

  const validators = Array.isArray(scope.validation?.validators)
    ? scope.validation.validators
    : []
  const results: LowImpactValidatorRecord[] = []
  const approvedBy = scope.validation?.approvedBy
  const approvalReference = scope.validation?.approvalReference

  for (const [index, validator] of validators.entries()) {
    const id = lowImpactValidatorId(index, validator.id)
    const method = lowImpactMethod(validator.method)
    const effectiveApprovedBy = validator.approvedBy ?? approvedBy
    const effectiveApprovalReference =
      validator.approvalReference ?? approvalReference
    const url = scopedValidatorUrl(target, validator)

    if (!method) {
      results.push(failedLowImpactRecord(validator, index, target, 'unsupported validator method'))
      continue
    }
    if (!effectiveApprovedBy || !effectiveApprovalReference) {
      results.push(
        failedLowImpactRecord(
          validator,
          index,
          target,
          'validator is missing separate approval metadata',
        ),
      )
      continue
    }
    if (!url) {
      results.push(
        failedLowImpactRecord(
          validator,
          index,
          target,
          'validator URL is outside the scoped target URL',
        ),
      )
      continue
    }
    if (method === 'http-status' && !Number.isInteger(validator.expectedStatus)) {
      results.push(
        failedLowImpactRecord(
          validator,
          index,
          target,
          'http-status validator requires expectedStatus',
        ),
      )
      continue
    }
    if (
      (method === 'http-header-present' ||
        method === 'http-header-absent' ||
        method === 'http-header-value-contains') &&
      !validator.header?.trim()
    ) {
      results.push(
        failedLowImpactRecord(
          validator,
          index,
          target,
          `${method} validator requires header`,
        ),
      )
      continue
    }
    if (
      (method === 'http-header-value-contains' || method === 'http-body-marker') &&
      !validator.expected?.trim()
    ) {
      results.push(
        failedLowImpactRecord(
          validator,
          index,
          target,
          `${method} validator requires expected marker`,
        ),
      )
      continue
    }

    const requestMethod = lowImpactRequestMethod(method, validator.requestMethod)
    try {
      const response = await fetch(url, {
        method: requestMethod,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'RedScope-AI-Low-Impact-Validator',
          Accept: '*/*',
        },
      })
      const bodySample =
        requestMethod === 'GET' && method === 'http-body-marker'
          ? await readResponseBodySample(response, lowImpactValidatorBodySampleBytes)
          : undefined
      const evaluation = evaluateLowImpactValidator(
        validator,
        method,
        response,
        bodySample,
      )
      results.push({
        id,
        title: validator.title ?? id,
        method,
        target: url,
        request: {
          method: requestMethod,
          url,
          redirect: 'manual',
          bodySent: false,
        },
        approval: {
          approvedBy: effectiveApprovedBy,
          approvalReference: effectiveApprovalReference,
        },
        status: evaluation.status,
        impactVerified: evaluation.impactVerified,
        severity: lowImpactSeverity(validator.severity),
        category: validator.category ?? 'low-impact-validation',
        evidence: evaluation.evidence,
        responseEvidence: evaluation.responseEvidence,
        impact:
          validator.impact ??
          'The approved low-impact validator confirmed the target condition.',
        remediation:
          validator.remediation ??
          'Review the confirmed target condition with the application owner and remediate inside the authorized change process.',
        references: list(validator.references),
        candidateCves: list(validator.candidateCves).map(item => item.toUpperCase()),
        cpe23Names: list(validator.cpe23Names),
        notes: list(validator.notes),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      results.push({
        ...failedLowImpactRecord(validator, index, target, reason),
        id,
        method,
        target: url,
        request: {
          method: requestMethod,
          url,
          redirect: 'manual',
          bodySent: false,
        },
        approval: {
          approvedBy: effectiveApprovedBy,
          approvalReference: effectiveApprovalReference,
        },
        status: 'failed',
      })
    }
  }

  const summary: LowImpactValidationSummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: validators.length > 0 ? 'completed' : 'skipped',
    target: target.normalizedUrl ?? target.raw,
    validatorCount: validators.length,
    verifiedCount: results.filter(result => result.impactVerified).length,
    results,
    policy: lowImpactValidationPolicy(),
  }

  await writeText(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-low-impact-validator', summary.target],
    cwd: projectPath(repoRoot),
    outputFiles: [projectPath(outputPath)],
    status: 'executed',
  }
}

async function runBusinessLogicValidatorStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
  scope: ScopeFile,
): Promise<PlannedCommand> {
  const outputDir = join(runDir, 'raw')
  const outputPath = join(outputDir, 'business-logic-validation.json')
  await mkdir(outputDir, { recursive: true })

  const testCases = Array.isArray(scope.logicValidation?.testCases)
    ? scope.logicValidation.testCases
    : []
  const approvedBy = scope.logicValidation?.approvedBy
  const approvalReference = scope.logicValidation?.approvalReference
  const actorSessions = await resolveBusinessLogicActorSessions(scope, target)
  const { actors, actorById } = buildBusinessLogicActors(scope, actorSessions)
  const results: BusinessLogicValidationRecord[] = []

  for (const [index, testCase] of testCases.entries()) {
    const id = businessLogicTestId(index, testCase.id)
    const mode = businessLogicMode(testCase.validationMode)
    const category = businessLogicCategory(testCase.category)
    const effectiveApprovedBy = testCase.approvedBy ?? approvedBy
    const effectiveApprovalReference =
      testCase.approvalReference ?? approvalReference

    if (!effectiveApprovedBy || !effectiveApprovalReference) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'test case is missing separate business-logic approval metadata',
        ),
      )
      continue
    }

    if (mode === 'manual-review') {
      results.push({
        ...failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'manual-review test case records workflow guidance only',
        ),
        id,
        category,
        validationMode: mode,
        approval: {
          approvedBy: effectiveApprovedBy,
          approvalReference: effectiveApprovalReference,
        },
        status: 'manual-review',
      })
      continue
    }

    if (mode === 'approved-state-changing-http') {
      results.push({
        ...failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'approved-state-changing-http requires the authorized-stateful-business-logic-validation profile',
        ),
        id,
        category,
        validationMode: mode,
        approval: {
          approvedBy: effectiveApprovedBy,
          approvalReference: effectiveApprovalReference,
        },
        status: 'skipped',
      })
      continue
    }

    if (mode === 'evidence-only') {
      const evidenceRefs = list(testCase.evidenceRefs)
      const impactVerified =
        testCase.observedImpact === true && evidenceRefs.length > 0
      results.push({
        id,
        title: testCase.title ?? id,
        category,
        validationMode: mode,
        target: testCase.target ?? target.normalizedUrl ?? target.raw,
        approval: {
          approvedBy: effectiveApprovedBy,
          approvalReference: effectiveApprovalReference,
        },
        actors: {
          controlActor: testCase.controlActor,
          testActor: testCase.testActor,
          objectOwnerActor: testCase.objectOwnerActor,
        },
        affectedObject: testCase.affectedObject,
        status: impactVerified ? 'verified' : 'not-verified',
        impactVerified,
        severity: businessLogicSeverity(testCase.severity),
        evidence: impactVerified
          ? [
              'Approved evidence-only business-logic test records verified target impact.',
              `Evidence reference count ${evidenceRefs.length}.`,
            ]
          : [
              'Evidence-only business-logic test did not include both observedImpact=true and evidence references.',
            ],
        requestEvidence: [],
        manualEvidenceRefs: evidenceRefs,
        expectedOutcome: testCase.expectedOutcome,
        observedOutcome: testCase.observedOutcome,
        impact:
          testCase.impact ??
          'Approved analyst evidence indicates business-logic impact on the target.',
        remediation:
          testCase.remediation ??
          'Review the affected business rule with the application owner and add server-side authorization/state validation.',
        references: list(testCase.references),
        cweIds: list(testCase.cweIds),
        notes: list(testCase.notes),
        parallelGroup: testCase.parallelGroup,
        isolatedTestFamily: testCase.isolatedTestFamily,
      })
      continue
    }

    const requestMethod = businessLogicRequestMethod(testCase.method)
    const url = scopedBusinessLogicUrl(target, testCase)
    if (!requestMethod) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'safe-readonly-http test cases may use only GET or HEAD',
        ),
      )
      continue
    }
    if (!url) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'test case URL is outside the scoped target URL',
        ),
      )
      continue
    }
    if (!testCase.testActor) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'safe-readonly-http test case requires testActor',
        ),
      )
      continue
    }

    const controlActor = testCase.controlActor
      ? actorById.get(testCase.controlActor)
      : undefined
    const testActor = actorById.get(testCase.testActor)
    const controlActorSession = testCase.controlActor
      ? actorSessions.get(testCase.controlActor)
      : undefined
    const testActorSession = actorSessions.get(testCase.testActor)
    const marker = testCase.expectedBodyMarker?.trim()
    const requestEvidence: BusinessLogicRequestEvidence[] = []

    if (testCase.controlActor) {
      requestEvidence.push(
        await executeBusinessLogicActorRequest(
          testCase.controlActor,
          controlActor,
          controlActorSession,
          requestMethod,
          url,
          marker,
        ),
      )
    }
    requestEvidence.push(
      await executeBusinessLogicActorRequest(
        testCase.testActor,
        testActor,
        testActorSession,
        requestMethod,
        url,
        marker,
      ),
    )

    const controlEvidence = testCase.controlActor
      ? requestEvidence.find(item => item.actorId === testCase.controlActor)
      : undefined
    const testEvidence = requestEvidence.find(
      item => item.actorId === testCase.testActor,
    )
    const expectedControlStatuses = statusList(
      testCase.expectedControlStatuses,
      [200, 201, 202, 204, 206, 301, 302, 304],
    )
    const expectedDeniedStatuses = statusList(
      testCase.expectedDeniedStatuses,
      [401, 403, 404],
    )
    const vulnerableStatuses = statusList(
      testCase.vulnerableStatuses,
      [200, 201, 202, 204, 206],
    )
    const controlPassed = controlEvidence
      ? statusAllowed(controlEvidence.status, expectedControlStatuses)
      : true
    const testDenied = statusAllowed(testEvidence?.status, expectedDeniedStatuses)
    const testLooksVulnerable =
      statusAllowed(testEvidence?.status, vulnerableStatuses) &&
      (!marker || testEvidence?.bodyMarkerMatched === true)
    const requestErrors = requestEvidence.filter(item => item.error)
    const impactVerified =
      requestErrors.length === 0 && controlPassed && !testDenied && testLooksVulnerable

    results.push({
      id,
      title: testCase.title ?? id,
      category,
      validationMode: mode,
      target: url,
      approval: {
        approvedBy: effectiveApprovedBy,
        approvalReference: effectiveApprovalReference,
      },
      actors: {
        controlActor: testCase.controlActor,
        testActor: testCase.testActor,
        objectOwnerActor: testCase.objectOwnerActor,
      },
      affectedObject: testCase.affectedObject,
      status:
        requestErrors.length > 0
          ? 'failed'
          : impactVerified
            ? 'verified'
            : 'not-verified',
      impactVerified,
      severity: businessLogicSeverity(testCase.severity),
      evidence: [
        `Control status ${controlEvidence?.status ?? 'not configured'}; test actor status ${testEvidence?.status ?? 'unavailable'}.`,
        testDenied
          ? 'Test actor received an expected denied status.'
          : 'Test actor did not receive an expected denied status.',
        marker
          ? `Approved body marker digest ${shortDigest(marker)} ${testEvidence?.bodyMarkerMatched ? 'matched' : 'did not match'} for the test actor.`
          : 'No body marker was required for this test case.',
      ],
      requestEvidence,
      manualEvidenceRefs: list(testCase.evidenceRefs),
      expectedOutcome: testCase.expectedOutcome,
      observedOutcome: testCase.observedOutcome,
      impact:
        testCase.impact ??
        'The business-logic test indicates an authorization or workflow control weakness.',
      remediation:
        testCase.remediation ??
        'Enforce server-side ownership, role, and state checks for every affected business action.',
      references: list(testCase.references),
      cweIds: list(testCase.cweIds),
      notes: list(testCase.notes),
      parallelGroup: testCase.parallelGroup,
      isolatedTestFamily: testCase.isolatedTestFamily,
      error:
        requestErrors.length > 0
          ? requestErrors.map(item => item.error).filter(Boolean).join('; ')
          : undefined,
    })
  }

  const summary: BusinessLogicValidationSummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: testCases.length > 0 ? 'completed' : 'skipped',
    target: target.normalizedUrl ?? target.raw,
    actorCount: actors.length,
    testCaseCount: testCases.length,
    verifiedCount: results.filter(result => result.impactVerified).length,
    actors,
    results,
    parallelExecutionPlan: buildParallelExecutionPlan(testCases),
    policy: businessLogicValidationPolicy(),
  }

  await writeText(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-business-logic-validator', summary.target],
    cwd: projectPath(repoRoot),
    outputFiles: [projectPath(outputPath)],
    status: 'executed',
  }
}

async function runStatefulBusinessLogicValidatorStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
  scope: ScopeFile,
): Promise<PlannedCommand> {
  const outputDir = join(runDir, 'raw')
  const outputPath = join(outputDir, 'business-logic-validation.json')
  await mkdir(outputDir, { recursive: true })

  const testCases = Array.isArray(scope.logicValidation?.testCases)
    ? scope.logicValidation.testCases
    : []
  const stateApproval = scope.logicValidation?.stateChangingApproval
  const actorSessions = await resolveBusinessLogicActorSessions(scope, target)
  const { actors, actorById } = buildBusinessLogicActors(scope, actorSessions)
  const results: BusinessLogicValidationRecord[] = []
  const maxMutatingRequests = Math.max(
    1,
    stateApproval?.maxMutatingRequests ?? 1,
  )
  let mutatingRequests = 0

  for (const [index, testCase] of testCases.entries()) {
    const id = businessLogicTestId(index, testCase.id)
    const mode = businessLogicMode(testCase.validationMode)
    const category = businessLogicCategory(testCase.category)
    const effectiveApprovedBy = testCase.approvedBy ?? stateApproval?.approvedBy
    const effectiveApprovalReference =
      testCase.approvalReference ?? stateApproval?.approvalReference
    const rollbackPlan = testCase.rollbackPlan ?? stateApproval?.rollbackPlan

    if (mode !== 'approved-state-changing-http') {
      results.push({
        ...failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'stateful profile runs only approved-state-changing-http test cases',
        ),
        id,
        category,
        validationMode: mode,
        status: 'skipped',
      })
      continue
    }

    if (!effectiveApprovedBy || !effectiveApprovalReference) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'test case is missing separate state-changing approval metadata',
        ),
      )
      continue
    }

    if (!stateApproval?.changeWindow?.trim()) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'logicValidation.stateChangingApproval.changeWindow is required',
        ),
      )
      continue
    }

    if (!rollbackPlan?.trim()) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'state-changing test case requires a rollbackPlan or stateChangingApproval.rollbackPlan',
        ),
      )
      continue
    }

    if (mutatingRequests >= maxMutatingRequests) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          `state-changing mutating request limit reached (${maxMutatingRequests})`,
        ),
      )
      continue
    }

    const requestMethod = statefulBusinessLogicRequestMethod(testCase.method)
    const url = scopedBusinessLogicUrl(target, testCase)
    if (!requestMethod) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'approved-state-changing-http test cases require POST, PUT, PATCH, or DELETE',
        ),
      )
      continue
    }
    if (!url) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'test case URL is outside the scoped target URL',
        ),
      )
      continue
    }
    if (!testCase.testActor) {
      results.push(
        failedBusinessLogicRecord(
          testCase,
          index,
          target,
          'approved-state-changing-http test case requires testActor',
        ),
      )
      continue
    }

    const requestBody = statefulRequestBodyMaterial(testCase)
    if (requestBody.error) {
      results.push(
        failedBusinessLogicRecord(testCase, index, target, requestBody.error),
      )
      continue
    }

    const testActor = actorById.get(testCase.testActor)
    const testActorSession = actorSessions.get(testCase.testActor)
    const marker = testCase.expectedBodyMarker?.trim()
    const requestEvidence = [
      await executeStatefulBusinessLogicActorRequest(
        testCase.testActor,
        testActor,
        testActorSession,
        requestMethod,
        url,
        requestBody,
        marker,
      ),
    ]
    mutatingRequests++

    const testEvidence = requestEvidence[0]
    const expectedDeniedStatuses = statusList(
      testCase.expectedDeniedStatuses,
      [401, 403, 404, 409, 422],
    )
    const vulnerableStatuses = statusList(
      testCase.vulnerableStatuses,
      [200, 201, 202, 204],
    )
    const testDenied = statusAllowed(testEvidence?.status, expectedDeniedStatuses)
    const testLooksVulnerable =
      statusAllowed(testEvidence?.status, vulnerableStatuses) &&
      (!marker || testEvidence?.bodyMarkerMatched === true)
    const evidenceRefs = list(testCase.evidenceRefs)
    const preconditionEvidenceRefs = list(testCase.preconditionEvidenceRefs)
    const requestErrors = requestEvidence.filter(item => item.error)
    const impactVerified =
      requestErrors.length === 0 &&
      !testDenied &&
      testLooksVulnerable &&
      testCase.observedImpact === true &&
      evidenceRefs.length > 0

    results.push({
      id,
      title: testCase.title ?? id,
      category,
      validationMode: mode,
      target: url,
      approval: {
        approvedBy: effectiveApprovedBy,
        approvalReference: effectiveApprovalReference,
      },
      actors: {
        controlActor: testCase.controlActor,
        testActor: testCase.testActor,
        objectOwnerActor: testCase.objectOwnerActor,
      },
      affectedObject: testCase.affectedObject,
      status:
        requestErrors.length > 0
          ? 'failed'
          : impactVerified
            ? 'verified'
            : 'not-verified',
      impactVerified,
      severity: businessLogicSeverity(testCase.severity),
      evidence: [
        `State-changing ${requestMethod} request returned status ${testEvidence?.status ?? 'unavailable'}.`,
        testDenied
          ? 'Test actor received an expected denied status.'
          : 'Test actor did not receive an expected denied status.',
        marker
          ? `Approved response marker digest ${shortDigest(marker)} ${testEvidence?.bodyMarkerMatched ? 'matched' : 'did not match'} for the test actor.`
          : 'No response body marker was required for this test case.',
        `Request body source ${requestBody.source}; request body digest ${requestBody.sha256 ?? 'none'}.`,
        `Precondition evidence reference count ${preconditionEvidenceRefs.length}.`,
        `Postcondition evidence reference count ${evidenceRefs.length}.`,
      ],
      requestEvidence,
      manualEvidenceRefs: evidenceRefs,
      preconditionEvidenceRefs,
      rollbackPlan,
      expectedOutcome: testCase.expectedOutcome,
      observedOutcome: testCase.observedOutcome,
      impact:
        testCase.impact ??
        'The state-changing business-logic test indicates an authorization, payment, workflow, upload, or injection control weakness.',
      remediation:
        testCase.remediation ??
        'Enforce server-side actor authorization, object ownership, state-transition guards, replay/idempotency checks, and strict input validation for the affected workflow.',
      references: list(testCase.references),
      cweIds: list(testCase.cweIds),
      notes: [
        ...list(testCase.notes),
        `State-changing approval window: ${stateApproval.changeWindow}.`,
        'Raw request bodies, response bodies, cookies, bearer tokens, and actor session headers were not persisted.',
      ],
      parallelGroup: testCase.parallelGroup,
      isolatedTestFamily: testCase.isolatedTestFamily,
      error:
        requestErrors.length > 0
          ? requestErrors.map(item => item.error).filter(Boolean).join('; ')
          : undefined,
    })
  }

  const summary: BusinessLogicValidationSummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: testCases.length > 0 ? 'completed' : 'skipped',
    target: target.normalizedUrl ?? target.raw,
    actorCount: actors.length,
    testCaseCount: testCases.length,
    verifiedCount: results.filter(result => result.impactVerified).length,
    actors,
    results,
    parallelExecutionPlan: buildParallelExecutionPlan(testCases),
    policy: statefulBusinessLogicValidationPolicy(scope),
  }

  await writeText(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-stateful-business-logic-validator', summary.target],
    cwd: projectPath(repoRoot),
    outputFiles: [projectPath(outputPath)],
    status: 'executed',
  }
}

type VulnerabilityAdvisoryQuery = {
  provider: VulnerabilityAdvisoryProvider
  queryType: VulnerabilityAdvisoryQueryType
  query: string
  url: string
}

function advisoryPolicy(): VulnerabilityAdvisorySummary['policy'] {
  return {
    targetHostIncludedInQueries: false,
    arbitraryPocExecutionAllowed: false,
    downloadsAllowed: false,
    notes: [
      'Advisory queries use CVE, product, and version fingerprint terms only; target hostnames are not included.',
      'Advisory records are public metadata for analyst review and prioritization.',
      'RedScope does not download, run, or import exploit code from advisory references.',
    ],
  }
}

function nvdApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    ...externalSearchHeaders,
    Accept: 'application/json',
  }
  const apiKey = process.env.NVD_API_KEY
  if (apiKey) headers.apiKey = apiKey
  return headers
}

function nvdApiUrl(params: Record<string, string>): string {
  const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0')
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }
  url.searchParams.set(
    'resultsPerPage',
    String(advisoryEnrichmentResultsPerQuery),
  )
  return url.toString()
}

function buildVulnerabilityAdvisoryQueries(
  fingerprints: FingerprintSummary,
  cveHints: string[],
): VulnerabilityAdvisoryQuery[] {
  const queries: VulnerabilityAdvisoryQuery[] = []
  const targetLower = fingerprints.target.toLowerCase()

  for (const cve of uniqueSorted(cveHints).slice(0, 2)) {
    queries.push({
      provider: 'nvd',
      queryType: 'cveIds',
      query: cve,
      url: nvdApiUrl({ cveId: cve }),
    })
  }

  for (const cpeName of fingerprints.cpe23Names.slice(0, 2)) {
    if (queries.length >= advisoryEnrichmentMaxQueries) break
    queries.push({
      provider: 'nvd',
      queryType: 'cpeName',
      query: cpeName,
      url: nvdApiUrl({ cpeName }),
    })
  }

  for (const pair of fingerprints.productVersionPairs.slice(0, 4)) {
    if (queries.length >= advisoryEnrichmentMaxQueries) break
    const vendors = productVendors(pair.product).slice(0, 1)
    const query = `${vendors.length > 0 ? `${vendors[0]} ` : ''}${pair.product} ${pair.version}`
    queries.push({
      provider: 'nvd',
      queryType: 'keyword',
      query,
      url: nvdApiUrl({ keywordSearch: query }),
    })
  }

  if (queries.length < advisoryEnrichmentMaxQueries) {
    for (const product of fingerprints.products.slice(0, 4)) {
      if (queries.length >= advisoryEnrichmentMaxQueries) break
      const version = fingerprints.versions[0]
      const vendors = productVendors(product).slice(0, 1)
      const query = `${vendors.length > 0 ? `${vendors[0]} ` : ''}${version ? `${product} ${version}` : product}`
      queries.push({
        provider: 'nvd',
        queryType: 'keyword',
        query,
        url: nvdApiUrl({ keywordSearch: query }),
      })
    }
  }

  return queries
    .filter(query => !query.query.toLowerCase().includes(targetLower))
    .slice(0, advisoryEnrichmentMaxQueries)
}

function compactSnippet(value: string, maxLength = 320): string {
  const normalized = stripHtml(value)
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`
}

function nvdDescription(cve: Record<string, unknown>): string | undefined {
  const descriptions = arrayField(cve, 'descriptions').filter(isRecord)
  const english =
    descriptions.find(item => stringField(item, 'lang') === 'en') ??
    descriptions.find(item => stringField(item, 'value'))
  return compactSnippet(stringField(english, 'value') ?? '')
}

function nvdReferences(cve: Record<string, unknown>, cveId: string): string[] {
  const direct = arrayField(cve, 'references').filter(isRecord)
  const nested = arrayField(recordField(cve, 'references'), 'referenceData').filter(
    isRecord,
  )
  return uniqueSorted([
    `https://nvd.nist.gov/vuln/detail/${cveId}`,
    ...[...direct, ...nested]
      .map(item => stringField(item, 'url'))
      .filter((item): item is string => Boolean(item))
      .slice(0, 8),
  ]).slice(0, 10)
}

function nvdCvss(
  cve: Record<string, unknown>,
): { version?: string; score?: number; severity?: string } {
  const metrics = recordField(cve, 'metrics')
  for (const key of [
    'cvssMetricV40',
    'cvssMetricV31',
    'cvssMetricV30',
    'cvssMetricV2',
  ]) {
    const metric = arrayField(metrics, key).filter(isRecord)[0]
    const cvssData = recordField(metric, 'cvssData')
    const score = numberField(cvssData, 'baseScore')
    const severity =
      stringField(metric, 'baseSeverity') ?? stringField(cvssData, 'baseSeverity')
    if (score != null || severity) {
      return {
        version: stringField(cvssData, 'version') ?? key.replace('cvssMetricV', ''),
        score,
        severity,
      }
    }
  }
  return {}
}

function nvdCpe23Names(cve: Record<string, unknown>): string[] {
  const names: string[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isRecord(value)) return
    const criteria = normalizeCpe23Name(stringField(value, 'criteria'))
    const cpe23Uri = normalizeCpe23Name(stringField(value, 'cpe23Uri'))
    if (criteria) names.push(criteria)
    if (cpe23Uri) names.push(cpe23Uri)
    for (const child of Object.values(value)) visit(child)
  }
  visit(cve.configurations)
  return uniqueSorted(names)
}

function advisorySeverityWeight(severity?: string): number {
  switch (severity?.toUpperCase()) {
    case 'CRITICAL':
      return 18
    case 'HIGH':
      return 14
    case 'MEDIUM':
      return 8
    case 'LOW':
      return 4
    default:
      return 0
  }
}

function parseNvdAdvisory(
  item: Record<string, unknown>,
  query: VulnerabilityAdvisoryQuery,
  fingerprints: FingerprintSummary,
  cveHints: string[],
): VulnerabilityAdvisoryRecord | undefined {
  const cve = recordField(item, 'cve')
  const cveId = stringField(cve, 'id')?.toUpperCase()
  if (!cve || !cveId || stringField(cve, 'vulnStatus') === 'Rejected') {
    return undefined
  }

  const descriptionSnippet = nvdDescription(cve)
  const references = nvdReferences(cve, cveId)
  const cvss = nvdCvss(cve)
  const cpe23Names = nvdCpe23Names(cve)
  const cisaExploitAdd = stringField(cve, 'cisaExploitAdd')
  const cisaActionDue = stringField(cve, 'cisaActionDue')
  const cisaVulnerabilityName = stringField(cve, 'cisaVulnerabilityName')
  const cisaKev = Boolean(cisaExploitAdd || cisaActionDue || cisaVulnerabilityName)
  const haystack = [
    cveId,
    descriptionSnippet ?? '',
    cisaVulnerabilityName ?? '',
    ...references,
    ...cpe23Names,
  ]
    .join('\n')
    .toLowerCase()
  const matchedProducts = matchedFingerprintProducts(haystack, fingerprints)
  const matchedVendors = matchedFingerprintVendors(haystack, fingerprints)
  const matchedVersions = fingerprints.versions.filter(term =>
    containsTerm(haystack, term),
  )
  const matchedCpe23Names = uniqueSorted(
    fingerprints.cpe23Names.filter(fingerprintCpe =>
      cpe23Names.some(advisoryCpe => cpeNamesMatch(fingerprintCpe, advisoryCpe)),
    ),
  )
  const matchedCves = cveHints.includes(cveId) ? [cveId] : []
  const evidenceScore = Math.min(
    100,
    20 +
      Math.min(matchedProducts.length, 3) * 14 +
      Math.min(matchedVendors.length, 2) * 6 +
      Math.min(matchedVersions.length, 2) * 20 +
      Math.min(matchedCpe23Names.length, 2) * 18 +
      (matchedCves.length > 0 ? 18 : 0) +
      (cisaKev ? 16 : 0) +
      advisorySeverityWeight(cvss.severity) +
      Math.round(fingerprints.confidenceScore * 0.12),
  )

  return {
    provider: query.provider,
    cveId,
    title: cisaVulnerabilityName ?? cveId,
    descriptionSnippet,
    published: stringField(cve, 'published'),
    lastModified: stringField(cve, 'lastModified'),
    vulnStatus: stringField(cve, 'vulnStatus'),
    cvssVersion: cvss.version,
    cvssScore: cvss.score,
    cvssSeverity: cvss.severity,
    cisaKev,
    cisaExploitAdd,
    cisaActionDue,
    cisaVulnerabilityName,
    cpe23Names,
    matchedProducts,
    matchedVendors,
    matchedVersions,
    matchedCpe23Names,
    matchedCves,
    evidenceScore,
    confidence: confidenceFromScore(evidenceScore),
    evidenceClass: 'public-intelligence-lead',
    references,
    notes: [
      'NVD advisory metadata is authoritative context, not proof that the scoped target is vulnerable.',
      'Use owner-confirmed product/version evidence before attempting validation.',
    ],
  }
}

async function fetchNvdAdvisories(
  query: VulnerabilityAdvisoryQuery,
  fingerprints: FingerprintSummary,
  cveHints: string[],
): Promise<VulnerabilityAdvisoryRecord[]> {
  const response = await fetch(query.url, {
    headers: nvdApiHeaders(),
    signal: AbortSignal.timeout(advisoryEnrichmentTimeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as unknown
  const vulnerabilities = isRecord(data)
    ? arrayField(data, 'vulnerabilities').filter(isRecord)
    : []
  return vulnerabilities
    .map(item => parseNvdAdvisory(item, query, fingerprints, cveHints))
    .filter(
      (item): item is VulnerabilityAdvisoryRecord => item !== undefined,
    )
}

async function runVulnerabilityAdvisoryEnrichment(
  fingerprints: FingerprintSummary,
  cveHints: string[],
): Promise<VulnerabilityAdvisorySummary> {
  const queries = buildVulnerabilityAdvisoryQueries(fingerprints, cveHints)
  const queryResults: VulnerabilityAdvisoryQueryResult[] = []
  const errors: VulnerabilityAdvisorySummary['errors'] = []
  const allAdvisories: VulnerabilityAdvisoryRecord[] = []

  if (queries.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: 'skipped',
      providers: ['nvd'],
      queryCount: 0,
      resultCount: 0,
      advisories: [],
      queryResults: [],
      errors: [],
      policy: advisoryPolicy(),
    }
  }

  for (const query of queries) {
    try {
      const advisories = await fetchNvdAdvisories(query, fingerprints, cveHints)
      allAdvisories.push(...advisories)
      queryResults.push({
        provider: query.provider,
        queryType: query.queryType,
        query: query.query,
        status: 'completed',
        resultCount: advisories.length,
        cveIds: advisories.map(advisory => advisory.cveId),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      errors.push({
        provider: query.provider,
        queryType: query.queryType,
        query: query.query,
        reason,
      })
      queryResults.push({
        provider: query.provider,
        queryType: query.queryType,
        query: query.query,
        status: 'failed',
        resultCount: 0,
        cveIds: [],
        reason,
      })
    }
  }

  const advisoriesByCve = new Map<string, VulnerabilityAdvisoryRecord>()
  for (const advisory of allAdvisories) {
    const existing = advisoriesByCve.get(advisory.cveId)
    if (!existing || advisory.evidenceScore > existing.evidenceScore) {
      advisoriesByCve.set(advisory.cveId, advisory)
    }
  }
  const advisories = Array.from(advisoriesByCve.values())
    .sort(
      (a, b) =>
        b.evidenceScore - a.evidenceScore ||
        (b.cvssScore ?? 0) - (a.cvssScore ?? 0) ||
        a.cveId.localeCompare(b.cveId),
    )
    .slice(0, 50)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'completed',
    providers: ['nvd'],
    queryCount: queries.length,
    resultCount: advisories.length,
    advisories,
    queryResults,
    errors,
    policy: advisoryPolicy(),
  }
}

function validationGatePolicy(): SafeValidationGateSummary['policy'] {
  return {
    arbitraryPocExecutionAllowed: false,
    networkProbeExecuted: false,
    notes: [
      'Evidence gates validate metadata correlation only; they do not prove exploitability.',
      'No exploit payloads, PoC repositories, or arbitrary code are executed by this gate.',
      'Ready candidates still require separately authorized low-impact validation and analyst review.',
    ],
  }
}

function gateCheck(
  id: string,
  label: string,
  status: ValidationGateStatus,
  evidence: string[],
): ValidationGateCheck {
  return { id, label, status, evidence }
}

function runSafeValidationGates(
  fingerprints: FingerprintSummary,
  candidates: PocCandidate[],
  externalSearch: ExternalPocSearchSummary,
  advisoryEnrichment: VulnerabilityAdvisorySummary,
): SafeValidationGateSummary {
  if (candidates.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: 'skipped',
      candidateCount: 0,
      validationReadyCount: 0,
      candidates: [],
      policy: validationGatePolicy(),
    }
  }

  const advisoryCves = new Set(
    advisoryEnrichment.advisories.map(advisory => advisory.cveId),
  )
  const advisoryCpes = new Set(
    advisoryEnrichment.advisories.flatMap(advisory => advisory.matchedCpe23Names),
  )
  const externalCves = new Set(
    externalSearch.results.flatMap(result => result.matchedCves),
  )

  const gatedCandidates = candidates.map(candidate => {
    const fingerprintReady = fingerprints.confidenceScore >= 45
    const sameContextReady =
      candidate.matchedProductVersionPairs.length > 0 ||
      candidate.matchedCpe23Names.length > 0
    const ownerVersionReady = ownerConfirmedVersionMatched(candidate, fingerprints)
    const cveAdvisoryMatched = candidate.matchedCves.some(cve =>
      advisoryCves.has(cve),
    )
    const cpeAdvisoryMatched = candidate.matchedCpe23Names.some(cpe =>
      advisoryCpes.has(cpe),
    )
    const externalMatched = candidate.matchedCves.some(cve => externalCves.has(cve))
    const reviewedTemplate =
      candidate.templateReview.status === 'allowlisted-low-impact'

    const checks = [
      gateCheck(
        'fingerprint-confidence',
        'Fingerprint confidence is medium or high',
        fingerprintReady ? 'passed' : 'failed',
        [`fingerprint score ${fingerprints.confidenceScore}/100`],
      ),
      gateCheck(
        'same-context-product-version',
        'Product/version or CPE evidence was observed in target fingerprint context',
        sameContextReady ? 'passed' : 'failed',
        [
          ...candidate.matchedProductVersionPairs.map(
            pair => `${pair.product}@${pair.version}`,
          ),
          ...candidate.matchedCpe23Names,
        ],
      ),
      gateCheck(
        'owner-confirmed-version-evidence',
        'Product and version were confirmed by owner-controlled evidence',
        ownerVersionReady ? 'passed' : 'failed',
        fingerprints.ownerConfirmedVersionEvidence
          .filter(evidence =>
            candidate.matchedProducts.some(
              product => canonicalProductName(product) === evidence.product,
            ),
          )
          .map(evidence =>
            `${evidence.product}@${evidence.version} via ${evidence.source}${evidence.evidenceId ? ` (${evidence.evidenceId})` : ''}`,
          ),
      ),
      gateCheck(
        'authoritative-advisory-correlation',
        'Candidate CVE or CPE is present in authoritative advisory metadata',
        candidate.matchedCves.length === 0 && candidate.matchedCpe23Names.length === 0
          ? 'not-applicable'
          : cveAdvisoryMatched || cpeAdvisoryMatched
            ? 'passed'
            : 'failed',
        [
          ...candidate.matchedCves.filter(cve => advisoryCves.has(cve)),
          ...candidate.matchedCpe23Names.filter(cpe => advisoryCpes.has(cpe)),
        ],
      ),
      gateCheck(
        'external-search-corroboration',
        'External search independently observed the same CVE identifier',
        candidate.matchedCves.length === 0
          ? 'not-applicable'
          : externalMatched
            ? 'passed'
            : 'failed',
        candidate.matchedCves.filter(cve => externalCves.has(cve)),
      ),
      gateCheck(
        'reviewed-template-source',
        'Candidate came from an allowlisted low-impact template source',
        reviewedTemplate ? 'passed' : 'not-applicable',
        reviewedTemplate
          ? [
              candidate.templateReview.templateId ?? candidate.sourceId,
              ...candidate.templateReview.reasons,
            ]
          : candidate.templateReview.reasons,
      ),
      gateCheck(
        'no-exploit-execution',
        'No arbitrary PoC or exploit code was executed',
        'passed',
        ['metadata-only evidence gate'],
      ),
    ]

    const gateScore =
      (fingerprintReady ? 22 : 0) +
      (sameContextReady ? 18 : 0) +
      (ownerVersionReady ? 20 : 0) +
      (cveAdvisoryMatched || cpeAdvisoryMatched ? 20 : 0) +
      (externalMatched ? 10 : 0) +
      (reviewedTemplate ? 8 : 0) +
      10
    const ready =
      gateScore >= 78 &&
      fingerprintReady &&
      sameContextReady &&
      ownerVersionReady &&
      (cveAdvisoryMatched || cpeAdvisoryMatched)

    return {
      sourceId: candidate.sourceId,
      sourcePath: candidate.sourcePath,
      matchedProducts: candidate.matchedProducts,
      matchedVersions: candidate.matchedVersions,
      matchedVendors: candidate.matchedVendors,
      matchedCpe23Names: candidate.matchedCpe23Names,
      matchedCves: candidate.matchedCves,
      evidenceClass: ready
        ? 'target-fingerprint-correlation'
        : candidate.evidenceClass,
      templateReview: candidate.templateReview,
      gateScore,
      status: ready
        ? 'ready-for-approved-low-impact-validation'
        : 'needs-manual-triage',
      confidence: confidenceFromScore(gateScore),
      checks,
      allowedFollowUp: ready
        ? 'A separately authorized low-impact validation profile may be reviewed by an analyst.'
        : 'Collect stronger owner-confirmed fingerprint/version evidence before validation.',
    } satisfies SafeValidationCandidate
  })

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'completed',
    candidateCount: gatedCandidates.length,
    validationReadyCount: gatedCandidates.filter(
      candidate => candidate.status === 'ready-for-approved-low-impact-validation',
    ).length,
    candidates: gatedCandidates,
    policy: validationGatePolicy(),
  }
}

async function sourceCandidates(
  sourceId: string,
  sourceDir: string,
  fingerprints: FingerprintSummary,
): Promise<PocCandidate[]> {
  const resolvedSourceDir = resolveProjectPath(sourceDir)
  assertInside(resolvedSourceDir, repoRoot, `${sourceId} source directory`)
  if (!(await pathExists(resolvedSourceDir))) return []
  if (fingerprints.products.length === 0 && fingerprints.versions.length === 0) {
    return []
  }

  const files = await walkFilesBounded(resolvedSourceDir, {
    maxFiles: pocCandidateFileLimit,
    allowedExtensions: pocCandidateExtensions,
  })
  const candidates: PocCandidate[] = []

  for (const file of files) {
    if (candidates.length >= pocCandidateMaxTriage) break
    const info = await stat(file)
    if (info.size > 2 * 1024 * 1024) continue
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, pocCandidateReadBytes))
      const read = await handle.read(buffer, 0, buffer.length, 0)
      const relativeSourcePath = relative(resolvedSourceDir, file)
        .split(sep)
        .join('/')
      const haystack = `${relativeSourcePath}\n${buffer
        .subarray(0, read.bytesRead)
        .toString('utf8')}`.toLowerCase()
      const matchedProducts = matchedFingerprintProducts(haystack, fingerprints)
      const matchedVersions = fingerprints.versions.filter(term =>
        containsTerm(haystack, term),
      )
      const matchedProductVersionPairs = matchedFingerprintPairs(
        haystack,
        fingerprints,
      )
      const matchedVendors = matchedFingerprintVendors(haystack, fingerprints)
      const matchedCpe23Names = matchedFingerprintCpes(haystack, fingerprints)
      const matchedCves = extractCves(haystack)
      const contextSignals = candidateContextSignals(haystack)
      if (matchedProducts.length === 0 && matchedCpe23Names.length === 0) {
        continue
      }
      const review = templateReview(sourceId, relativeSourcePath, haystack)
      const candidateEvidenceSeed = {
        matchedProducts,
        matchedVersions,
        matchedProductVersionPairs,
        matchedCpe23Names,
      }
      const hasOwnerConfirmedVersion = ownerConfirmedVersionMatched(
        candidateEvidenceSeed,
        fingerprints,
      )
      const evidenceScore = scorePocCandidate(
        sourceId,
        fingerprints,
        matchedProducts,
        matchedVersions,
        matchedProductVersionPairs,
        matchedVendors,
        matchedCpe23Names,
        matchedCves,
        contextSignals,
        review,
        hasOwnerConfirmedVersion,
      )
      const triageStatus = pocTriageStatus(
        evidenceScore,
        matchedVersions,
        matchedProductVersionPairs,
        matchedCpe23Names,
        matchedCves,
        review,
        hasOwnerConfirmedVersion,
      )
      const evidenceClass: EvidenceClass = hasOwnerConfirmedVersion
        ? 'owner-confirmed-target-version'
        : matchedProductVersionPairs.length > 0 || matchedCpe23Names.length > 0
          ? 'target-fingerprint-correlation'
          : 'public-intelligence-lead'
      const candidateCore = {
        matchedProducts,
        matchedVersions,
        matchedProductVersionPairs,
        matchedCpe23Names,
        matchedCves,
        templateReview: review,
        evidenceClass,
        triageStatus,
      }
      candidates.push({
        sourceId,
        sourcePath: projectPath(file),
        relativeSourcePath,
        matchedProducts,
        matchedVersions,
        matchedProductVersionPairs,
        matchedVendors,
        matchedCpe23Names,
        matchedCves,
        contextSignals,
        templateReview: review,
        evidenceClass,
        evidenceScore,
        confidence: confidenceFromScore(evidenceScore),
        triageStatus,
        reason: pocCandidateReason(candidateCore),
      })
    } finally {
      await handle.close()
    }
  }

  return candidates
}

async function runPocCandidateValidationStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
  scope: ScopeFile,
): Promise<PlannedCommand> {
  const outputDir = join(runDir, 'raw')
  const outputPath = join(outputDir, 'poc-validation-plan.json')
  const searchOutputPath = join(outputDir, 'poc-search-enrichment.json')
  const advisoryOutputPath = join(
    outputDir,
    'vulnerability-advisory-enrichment.json',
  )
  const validationGatesOutputPath = join(outputDir, 'validation-evidence-gates.json')
  const screenshotsDir = join(outputDir, 'screenshots')
  await mkdir(outputDir, { recursive: true })
  await mkdir(screenshotsDir, { recursive: true })

  const baseline = await readJsonIfExists<Record<string, unknown>>(
    join(outputDir, 'baseline-url.json'),
  )
  const fingerprints = extractFingerprintSummary(target, baseline, scope)
  const sourceState = await readSourceState()
  const allCandidates: PocCandidate[] = []
  const sourceRecords = Object.entries(sourceState.sources ?? {})

  for (const [sourceId, record] of sourceRecords) {
    if (record.status !== 'available' || !record.sourceDir) continue
    allCandidates.push(
      ...(await sourceCandidates(sourceId, record.sourceDir, fingerprints)),
    )
    if (allCandidates.length >= pocCandidateMaxTriage) break
  }

  const rankedCandidates = [...allCandidates].sort(
    (a, b) =>
      b.evidenceScore - a.evidenceScore ||
      b.matchedProductVersionPairs.length - a.matchedProductVersionPairs.length ||
      b.matchedVersions.length - a.matchedVersions.length ||
      b.matchedCves.length - a.matchedCves.length,
  )
  const candidates = rankedCandidates
    .filter(candidate => candidate.triageStatus === 'planned-validation')
    .slice(0, pocCandidateMaxMatches)
  const triageQueue = rankedCandidates
    .filter(candidate => candidate.triageStatus === 'triage-only')
    .slice(0, pocCandidateMaxMatches)
  const localCves = uniqueSorted(
    rankedCandidates.flatMap(candidate => candidate.matchedCves),
  )
  const externalSearch = await runExternalPocSearch(fingerprints, localCves)
  await writeText(searchOutputPath, `${JSON.stringify(externalSearch, null, 2)}\n`)
  const advisoryCveHints = uniqueSorted([
    ...localCves,
    ...externalSearch.results.flatMap(result => result.matchedCves),
  ])
  const advisoryEnrichment = await runVulnerabilityAdvisoryEnrichment(
    fingerprints,
    advisoryCveHints,
  )
  await writeText(
    advisoryOutputPath,
    `${JSON.stringify(advisoryEnrichment, null, 2)}\n`,
  )
  const validationGates = runSafeValidationGates(
    fingerprints,
    candidates,
    externalSearch,
    advisoryEnrichment,
  )
  await writeText(
    validationGatesOutputPath,
    `${JSON.stringify(validationGates, null, 2)}\n`,
  )
  const plannedAttempts = candidates.slice(0, pocCandidateMaxMatches).map(candidate => ({
    sourceId: candidate.sourceId,
    sourcePath: candidate.sourcePath,
    matchedProducts: candidate.matchedProducts,
    matchedVersions: candidate.matchedVersions,
    matchedProductVersionPairs: candidate.matchedProductVersionPairs,
    matchedVendors: candidate.matchedVendors,
    matchedCpe23Names: candidate.matchedCpe23Names,
    matchedCves: candidate.matchedCves,
    templateReview: candidate.templateReview,
    evidenceClass: candidate.evidenceClass,
    evidenceScore: candidate.evidenceScore,
    confidence: candidate.confidence,
    attemptStatus: 'gated',
    allowedAttempt:
      candidate.templateReview.status === 'allowlisted-low-impact'
        ? 'Run a separately authorized nuclei profile with reviewed low-impact templates.'
        : 'Manual analyst review is required before any validation attempt.',
    reason: candidate.reason,
  }))

  await writeText(
    join(screenshotsDir, 'README.md'),
    [
      '# Screenshot Evidence',
      '',
      'Attach browser or tool screenshots for this validation run in this directory.',
      'The report pipeline indexes PNG, JPG, JPEG, WebP, GIF, and this README as evidence.',
      '',
      'Do not include secrets, session tokens, private messages, or unrelated user data in screenshots.',
      '',
    ].join('\n'),
  )

  await writeText(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        target: fingerprints.target,
        fingerprintSource: baseline
          ? 'raw/baseline-url.json'
          : 'target metadata only; baseline evidence was not available',
        fingerprints,
        sourceStatePath: envPathFrom(
          ['REDSCOPE_TOOLS_SOURCE_STATE', 'REDSCOPE_SOURCE_STATE'],
          'tools/manifests/redscope-source-state.json',
        ),
        sourceCount: sourceRecords.length,
        rawCandidateCount: allCandidates.length,
        candidateCount: candidates.length,
        triageQueueCount: triageQueue.length,
        externalSearch: {
          path: projectPath(searchOutputPath),
          status: externalSearch.status,
          providers: externalSearch.providers,
          queryCount: externalSearch.queryCount,
          resultCount: externalSearch.resultCount,
          errorCount: externalSearch.errors.length,
        },
        advisoryEnrichment: {
          path: projectPath(advisoryOutputPath),
          status: advisoryEnrichment.status,
          providers: advisoryEnrichment.providers,
          queryCount: advisoryEnrichment.queryCount,
          resultCount: advisoryEnrichment.resultCount,
          errorCount: advisoryEnrichment.errors.length,
        },
        validationGates: {
          path: projectPath(validationGatesOutputPath),
          status: validationGates.status,
          candidateCount: validationGates.candidateCount,
          validationReadyCount: validationGates.validationReadyCount,
        },
        candidates,
        triageQueue,
        plannedAttempts,
        scoring: {
          acceptedCandidateThreshold:
            'score >= 60 with version evidence plus CVE/template historical signal',
          productOnlyHandling:
            'product-only source hits are retained in triageQueue and are not planned as validation attempts',
          maxPlannedCandidates: pocCandidateMaxMatches,
          maxTriageCandidates: pocCandidateMaxTriage,
          requiredValidationReadyEvidence:
            'medium-or-better fingerprint confidence, same-context product/version or CPE evidence, owner-confirmed product/version evidence, and authoritative advisory CVE/CPE correlation',
        },
        policy: {
          arbitraryPocExecutionAllowed: false,
          requiresAuthorizedScope: true,
          requiresExecuteFlag: true,
          requiresActiveConfirmation: true,
          notes: [
            'Downloaded PoC/source content is quarantined reference material.',
            'This step matches fingerprints, vendor hints, CPE 2.3 hints, owner-confirmed versions, and CVE evidence to candidate PoC/template files.',
            'Weak product-only and public-intelligence-only hits are not promoted to validation attempts.',
            'External search enrichment stores links and metadata only; it does not download or execute PoC code.',
            'Advisory enrichment stores public vulnerability metadata only and does not prove target exploitability.',
            'Public intelligence leads, target fingerprint correlations, owner-confirmed target versions, and target-verified issues are tracked as separate evidence classes.',
            'Automatic validation gates check evidence correlation only; they do not execute exploit payloads.',
            'It does not execute arbitrary PoC code from tools/sources.',
            'Only separately wired low-impact validators may run, and only through explicit authorized profiles.',
          ],
        },
        screenshots: {
          directory: projectPath(screenshotsDir),
          status: 'pending-operator-capture',
          notes: [
            'Capture screenshots during approved validation and place them in this directory.',
            'The report pipeline will index attached screenshot files as evidence.',
          ],
        },
      },
      null,
      2,
    )}\n`,
  )

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-poc-candidate-validation', fingerprints.target],
    cwd: projectPath(repoRoot),
    outputFiles: [
      projectPath(outputPath),
      projectPath(searchOutputPath),
      projectPath(advisoryOutputPath),
      projectPath(validationGatesOutputPath),
      projectPath(screenshotsDir),
    ],
    status: 'executed',
  }
}

async function readResponseBodySample(response: Response, maxBytes = httpBaselineBodySampleBytes): Promise<{
  sampledBytes: number
  truncated: boolean
  sha256: string
  text: string
}> {
  const reader = response.body?.getReader()
  if (!reader) {
    return {
      sampledBytes: 0,
      truncated: false,
      sha256: shortDigest(''),
      text: '',
    }
  }

  const chunks: Uint8Array[] = []
  let sampledBytes = 0
  let truncated = false

  while (sampledBytes < maxBytes) {
    const { done, value } = await reader.read()
    if (done || !value) break
    const remaining = maxBytes - sampledBytes
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining))
      sampledBytes += remaining
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    sampledBytes += value.byteLength
  }
  if (sampledBytes >= maxBytes && !truncated) {
    truncated = true
    await reader.cancel()
  }

  const sample = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  return {
    sampledBytes,
    truncated,
    sha256: createHash('sha256').update(sample).digest('hex'),
    text: new TextDecoder('utf-8', { fatal: false }).decode(sample),
  }
}

function htmlAttributeValues(html: string, attribute: string): string[] {
  const values: string[] = []
  const pattern = new RegExp(`${attribute}\\s*=\\s*["']([^"']{1,160})["']`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    values.push(match[1])
    if (values.length >= 12) break
  }
  return uniqueSorted(values)
}

function htmlMetaGeneratorValues(html: string): string[] {
  const values: string[] = []
  const patterns = [
    /<meta\b(?=[^>]*\bname\s*=\s*["']generator["'])(?=[^>]*\bcontent\s*=\s*["']([^"']{1,180})["'])[^>]*>/gi,
    /<meta\b(?=[^>]*\bcontent\s*=\s*["']([^"']{1,180})["'])(?=[^>]*\bname\s*=\s*["']generator["'])[^>]*>/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null) {
      values.push(match[1])
      if (values.length >= 12) break
    }
  }
  return uniqueSorted(values)
}

function bodySignatureObservations(html: string): FingerprintObservation[] {
  const observations: FingerprintObservation[] = []
  const lower = html.toLowerCase()

  for (const value of htmlMetaGeneratorValues(html)) {
    const observation = buildFingerprintObservation(
      'html',
      'meta-generator',
      value,
      [],
      58,
    )
    if (observation) observations.push(observation)
  }

  for (const value of htmlAttributeValues(html, 'ng-version')) {
    const observation = buildFingerprintObservation(
      'html',
      'ng-version',
      `angular ${value}`,
      ['angular'],
      56,
    )
    if (observation) observations.push(observation)
  }

  const signatureRules: Array<{
    name: string
    products: string[]
    patterns: RegExp[]
    score: number
  }> = [
    {
      name: 'wordpress-asset-path',
      products: ['wordpress'],
      patterns: [/wp-content\//i, /wp-includes\//i],
      score: 46,
    },
    {
      name: 'drupal-body-signature',
      products: ['drupal'],
      patterns: [/drupal-settings-json/i, /\/sites\/default\//i],
      score: 46,
    },
    {
      name: 'joomla-body-signature',
      products: ['joomla'],
      patterns: [/content=["'][^"']*joomla/i, /\/media\/system\/js\//i],
      score: 44,
    },
    {
      name: 'magento-body-signature',
      products: ['magento'],
      patterns: [/mage\/cookies/i, /magento_[a-z]+/i, /\/static\/version\d+\//],
      score: 46,
    },
    {
      name: 'nextjs-body-signature',
      products: ['nextjs'],
      patterns: [/__NEXT_DATA__/i, /\/_next\/static\//i],
      score: 48,
    },
    {
      name: 'nuxt-body-signature',
      products: ['nuxt'],
      patterns: [/__NUXT__/i, /\/_nuxt\//i],
      score: 44,
    },
    {
      name: 'rails-body-signature',
      products: ['rails'],
      patterns: [/csrf-param/i, /csrf-token/i, /action_cable/i],
      score: 38,
    },
    {
      name: 'aspnet-body-signature',
      products: ['aspnet'],
      patterns: [/__VIEWSTATE/i, /__EVENTVALIDATION/i],
      score: 42,
    },
  ]

  for (const rule of signatureRules) {
    if (!rule.patterns.some(pattern => pattern.test(lower))) continue
    const observation = buildFingerprintObservation(
      'body',
      rule.name,
      `${rule.name} ${rule.products.join(' ')}`,
      rule.products,
      rule.score,
    )
    if (observation) observations.push(observation)
  }

  return observations
}

function setCookieHeaderValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ?? []
  const combined = headers.get('set-cookie')
  if (combined) values.push(combined)
  return values
}

const cookieProductHints: Record<string, string[]> = {
  'asp.net_sessionid': ['aspnet'],
  jsessionid: ['java', 'tomcat'],
  laravel_session: ['laravel'],
  phpsessid: ['php'],
  '_rails_session': ['rails'],
  woocommerce_cart_hash: ['wordpress', 'woocommerce'],
  wordpress_logged_in: ['wordpress'],
  wordpress_sec: ['wordpress'],
}

function cookieFingerprintObservations(headers: Headers): FingerprintObservation[] {
  const cookieNames = uniqueSorted(
    setCookieHeaderValues(headers).flatMap(value =>
      Array.from(value.matchAll(/(?:^|,\s*)([A-Za-z0-9_.-]{2,64})=/g)).map(
        match => match[1].toLowerCase(),
      ),
    ),
  ).slice(0, 20)
  const observations: FingerprintObservation[] = []

  for (const cookieName of cookieNames) {
    const products = cookieProductHints[cookieName]
    if (!products) continue
    const observation = buildFingerprintObservation(
      'cookie',
      'set-cookie-name',
      cookieName,
      products,
      34,
    )
    if (observation) observations.push(observation)
  }

  return observations
}

function buildHttpFingerprintSignals(
  response: Response,
  bodySample: Awaited<ReturnType<typeof readResponseBodySample>>,
) {
  const observations = [
    ...cookieFingerprintObservations(response.headers),
    ...bodySignatureObservations(bodySample.text),
  ]
  return {
    bodySample: {
      sampledBytes: bodySample.sampledBytes,
      maxSampleBytes: httpBaselineBodySampleBytes,
      truncated: bodySample.truncated,
      sha256: bodySample.sha256,
      rawBodyStored: false,
    },
    observations,
    observationCount: observations.length,
    notes: [
      'Only a bounded response-body sample was read for derived fingerprints.',
      'Raw body text is not persisted; only hashes, counts, and derived product/version observations are stored.',
      'Cookie fingerprinting stores inferred products from cookie names only, not cookie values.',
    ],
  }
}

async function runInternalStep(
  step: ProfileStep,
  target: TargetPlan,
  runDir: string,
  scope: ScopeFile,
  egress?: AuthorizedEgressSession,
): Promise<PlannedCommand> {
  const outputDir = join(runDir, 'raw')
  await mkdir(outputDir, { recursive: true })

  if (step.kind === 'internal') {
    const filePath = join(outputDir, `${step.id}.md`)
    const content = [
      `# ${step.description}`,
      '',
      `Target: ${target.raw}`,
      `Matched by: ${target.matchedBy.join(', ')}`,
      '',
      'This internal step records analyst guidance only and performs no probing.',
      '',
    ].join('\n')
    await writeText(filePath, content)
    return {
      stepId: step.id,
      kind: step.kind,
      argv: [],
      cwd: projectPath(repoRoot),
      outputFiles: [projectPath(filePath)],
      status: 'executed',
    }
  }

  if (step.kind === 'internal-artifact-summary') {
    return runArtifactSummaryStep(step, target, runDir)
  }

  if (step.kind === 'internal-poc-candidate-validation') {
    return runPocCandidateValidationStep(step, target, runDir, scope)
  }

  if (step.kind === 'internal-low-impact-validator') {
    return runLowImpactValidatorStep(step, target, runDir, scope)
  }

  if (step.kind === 'internal-business-logic-validator') {
    return runBusinessLogicValidatorStep(step, target, runDir, scope)
  }

  if (step.kind === 'internal-stateful-business-logic-validator') {
    return runStatefulBusinessLogicValidatorStep(step, target, runDir, scope)
  }

  const targetUrl = target.normalizedUrl ?? target.raw
  const controller = AbortSignal.timeout(15000)
  const response = await fetchWithAuthorizedEgress(
    egress,
    targetUrl,
    {
      method: 'GET',
      redirect: 'manual',
      signal: controller,
      headers: {
        'User-Agent': 'RedScope-AI-Baseline-Review',
        Accept: '*/*',
      },
    },
    {
      retryOnBlockStatus: true,
      retryOnNetworkError: true,
      reason: 'internal HTTP baseline target-side block signal',
    },
  )
  const headers: Record<string, string> = {}
  for (const [key, value] of response.headers.entries()) {
    if (
      [
        'content-type',
        'content-length',
        'location',
        'server',
        'x-powered-by',
        'x-aspnet-version',
        'x-generator',
        'x-drupal-cache',
        'x-drupal-dynamic-cache',
        'x-nextjs-cache',
        'x-rails-version',
        'x-magento-cache-debug',
        'x-litespeed-cache',
        'x-shopify-stage',
        'strict-transport-security',
        'content-security-policy',
        'x-frame-options',
        'x-content-type-options',
        'referrer-policy',
        'permissions-policy',
      ].includes(key.toLowerCase())
    ) {
      headers[key] = value
    }
  }
  const bodySample = await readResponseBodySample(response)
  const fingerprintSignals = buildHttpFingerprintSignals(response, bodySample)

  const outputPath = join(outputDir, 'baseline-url.json')
  await writeText(
    outputPath,
    `${JSON.stringify(
      {
        target: targetUrl,
        fetchedAt: new Date().toISOString(),
        status: response.status,
        statusText: response.statusText,
        redirected: response.redirected,
        responseUrl: response.url,
        headers,
        fingerprintSignals,
        bodyStored: false,
        notes: [
          'Only headers, status metadata, and derived fingerprint signals are stored.',
          'A bounded response-body sample may be read for fingerprint derivation, but raw body text is intentionally not persisted.',
        ],
      },
      null,
      2,
    )}\n`,
  )

  return {
    stepId: step.id,
    kind: step.kind,
    argv: ['redscope-internal-http-baseline', targetUrl],
    cwd: projectPath(repoRoot),
    outputFiles: [projectPath(outputPath)],
    status: 'executed',
    egress: egressRecord(egress),
  }
}

async function runToolCommand(
  command: PlannedCommand,
  egress?: AuthorizedEgressSession,
): Promise<PlannedCommand> {
  if (command.status === 'skipped') return command
  if (command.argv.length === 0) return command

  const stdoutPath = resolveProjectPath(
    command.outputFiles[0] ? `${command.outputFiles[0]}.stdout.txt` : `tools/outputs/${command.stepId}.stdout.txt`,
  )
  const stderrPath = resolveProjectPath(
    command.outputFiles[0] ? `${command.outputFiles[0]}.stderr.txt` : `tools/outputs/${command.stepId}.stderr.txt`,
  )
  await mkdir(dirname(stdoutPath), { recursive: true })
  await mkdir(dirname(stderrPath), { recursive: true })

  const stdoutParts: string[] = []
  const stderrParts: string[] = []
  let exitCode = 1

  for (;;) {
    await resetPrimaryToolOutput(command)
    const env = spawnEnvForCommand(command, egress)
    const proc = Bun.spawn(command.argv, {
      cwd: resolveProjectPath(command.cwd),
      stdout: 'pipe',
      stderr: 'pipe',
      ...(env ? { env } : {}),
    })
    const stdoutPromise = new Response(proc.stdout).text()
    const stderrPromise = new Response(proc.stderr).text()
    exitCode = await proc.exited
    const stdout = await stdoutPromise
    const stderr = await stderrPromise
    stdoutParts.push(stdout)
    stderrParts.push(stderr)

    const blockStatus = await toolOutputBlockStatus(command, egress)
    if (egress?.enabled && commandUsesTargetEgress(command)) {
      const shouldSwitch = exitCode !== 0 || blockStatus !== undefined
      if (shouldSwitch) {
        const switched = await recordBlockAndSwitchAuthorizedEgress(egress, {
          statusCode: blockStatus,
          reason:
            blockStatus !== undefined
              ? `${command.tool} observed target-side HTTP ${blockStatus}`
              : `${command.tool} exited with code ${exitCode}`,
        })
        if (switched) continue
      }
    }
    break
  }

  await writeFile(stdoutPath, stdoutParts.join('\n'))
  await writeFile(stderrPath, stderrParts.join('\n'))

  return {
    ...command,
    outputFiles: [
      ...command.outputFiles,
      projectPath(stdoutPath),
      projectPath(stderrPath),
    ],
    status: exitCode === 0 ? 'executed' : 'failed',
    exitCode,
    egress: egressRecord(egress),
  }
}

async function executeSteps(
  profile: RunProfile,
  target: TargetPlan,
  runDir: string,
  commands: PlannedCommand[],
  scope: ScopeFile,
  egress?: AuthorizedEgressSession,
): Promise<PlannedCommand[]> {
  const executed: PlannedCommand[] = []
  for (const step of profile.steps) {
    if (
      step.kind === 'internal' ||
      step.kind === 'internal-http-baseline' ||
      step.kind === 'internal-artifact-summary' ||
      step.kind === 'internal-poc-candidate-validation' ||
      step.kind === 'internal-low-impact-validator' ||
      step.kind === 'internal-business-logic-validator' ||
      step.kind === 'internal-stateful-business-logic-validator'
    ) {
      try {
        executed.push(await runInternalStep(step, target, runDir, scope, egress))
      } catch (error) {
        executed.push({
          stepId: step.id,
          kind: step.kind,
          argv: [],
          cwd: projectPath(repoRoot),
          outputFiles: [],
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      continue
    }

    const planned = commands.find(command => command.stepId === step.id)
    if (!planned) continue
    executed.push(await runToolCommand(planned, egress))
  }
  return executed
}

function reportMarkdown(
  profile: RunProfile,
  target: TargetPlan,
  runDir: string,
  limits: ReturnType<typeof effectiveRateLimits>,
  commands: PlannedCommand[],
  executed: boolean,
): string {
  const lines = [
    `# RedScope ${profile.name}`,
    '',
    `Profile: \`${profile.id}\``,
    `Risk level: \`${profile.riskLevel}\``,
    `Target: \`${target.raw}\``,
    `Run directory: \`${projectPath(runDir)}\``,
    `Mode: ${executed ? 'executed' : 'planned'}`,
    '',
    '## Scope Match',
    '',
    `Matched by: ${target.matchedBy.join(', ')}`,
    '',
    '## Effective Limits',
    '',
    `- Requests per second: ${limits.requestsPerSecond}`,
    `- Concurrency: ${limits.concurrency}`,
    `- Max targets: ${limits.maxTargets}`,
    '',
    '## Stop Conditions',
    '',
    ...profile.stopConditions.map(item => `- ${item}`),
    '',
    '## Commands',
    '',
    ...commands.map(command => {
      const commandText = command.argv.length > 0 ? command.argv.join(' ') : '(internal)'
      const suffix = command.reason ? ` - ${command.reason}` : ''
      return `- ${command.stepId}: ${command.status}${suffix}\n  \`${commandText}\``
    }),
    '',
    '## Findings',
    '',
    'Findings are populated by Phase 4 normalization. Raw outputs are referenced above.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

async function ensureRunDir(runDir: string, force: boolean) {
  if (await pathExists(runDir)) {
    const info = await stat(runDir)
    if (!info.isDirectory()) throw new Error(`${projectPath(runDir)} is not a directory`)
    const entries = await readdir(runDir)
    if (entries.length > 0 && !force) {
      throw new Error(`${projectPath(runDir)} already exists. Pass --force to reuse it.`)
    }
  }
  await mkdir(runDir, { recursive: true })
}

async function writeRunArtifacts(
  runDir: string,
  profile: RunProfile,
  scope: ScopeFile,
  scopePath: string,
  target: TargetPlan,
  limits: ReturnType<typeof effectiveRateLimits>,
  commands: PlannedCommand[],
  executed: boolean,
) {
  await mkdir(runDir, { recursive: true })
  await mkdir(join(runDir, 'raw'), { recursive: true })
  await writeText(join(runDir, 'targets.txt'), buildTargetsText(target))
  await writeText(
    join(runDir, 'scope.snapshot.json'),
    `${JSON.stringify(scope, null, 2)}\n`,
  )
  await writeText(
    join(runDir, 'command-manifest.json'),
    `${JSON.stringify(commands, null, 2)}\n`,
  )
  await writeText(
    join(runDir, 'run.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        status: executed ? 'executed' : 'planned',
        profile: {
          id: profile.id,
          name: profile.name,
          riskLevel: profile.riskLevel,
          allowedTools: profile.allowedTools,
          reportTemplate: profile.reportTemplate,
        },
        authorization: {
          scopePath: projectPath(scopePath),
          owner: scope.owner,
          authorizedBy: scope.authorization?.authorizedBy,
          reference: scope.authorization?.reference ?? null,
          validFrom: scope.authorization?.validFrom,
          validTo: scope.authorization?.validTo,
        },
        target,
        effectiveRateLimits: limits,
        stopConditions: profile.stopConditions,
        files: {
          scopeSnapshot: 'scope.snapshot.json',
          targets: 'targets.txt',
          commandManifest: 'command-manifest.json',
          report: 'report.md',
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeText(
    join(runDir, 'report.md'),
    reportMarkdown(profile, target, runDir, limits, commands, executed),
  )
}

async function runProfile(options: Options) {
  const profilesPath = resolveProjectPath(options.profilesPath)
  const registry = await loadProfiles(profilesPath)

  if (options.command === 'list') {
    listProfiles(registry, options.json)
    return
  }

  if (!options.profileId || !options.scopePath) usage()
  const profile = findProfile(registry, options.profileId)
  const activeConfirmLevels =
    registry.policy?.requiresActiveConfirmationForLevels ?? ['active', 'restricted']
  if (
    options.execute &&
    activeConfirmLevels.includes(profile.riskLevel) &&
    !options.confirmActive
  ) {
    throw new Error(`${profile.id} requires --confirm-active when executing`)
  }

  const scopePath = resolveProjectPath(options.scopePath)
  assertInside(scopePath, repoRoot, 'scope path')
  const scope = await readJsonFile<ScopeFile>(scopePath)
  validateScope(scope, profile)
  const target = validateTarget(scope, profile, options)
  const limits = effectiveRateLimits(scope, profile)
  const outputRoot = resolveProjectPath(
    options.outputRoot ??
      registry.policy?.outputRoot ??
      envPathFrom(
        ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
        'tools/outputs',
      ),
  )
  assertInside(outputRoot, repoRoot, 'output root')
  const profileRoot = resolve(outputRoot, profile.id)
  const currentRunId = runId(profile, target)
  const runDir = resolve(profileRoot, currentRunId)
  assertInside(runDir, outputRoot, 'run directory')
  const egress =
    options.execute && profileUsesTargetEgress(profile, target)
      ? await createAuthorizedEgressSession(target.normalizedUrl ?? target.raw)
      : undefined

  try {
    const commands = await buildCommands(
      profile,
      target,
      runDir,
      limits,
      options,
      scope,
    )

    if (options.dryRun) {
      const dryRun = {
        dryRun: true,
        profile: profile.id,
        target,
        runDir: projectPath(runDir),
        effectiveRateLimits: limits,
        commands,
        stopConditions: profile.stopConditions,
      }
      console.log(JSON.stringify(dryRun, null, 2))
      return
    }

    await ensureRunDir(runDir, options.force)
    await writeRunArtifacts(runDir, profile, scope, scopePath, target, limits, commands, false)
    await writeAuthorizedEgressManifest(runDir, egress)

    let finalCommands = commands
    if (options.execute) {
      finalCommands = await executeSteps(
        profile,
        target,
        runDir,
        commands,
        scope,
        egress,
      )
      await writeRunArtifacts(
        runDir,
        profile,
        scope,
        scopePath,
        target,
        limits,
        finalCommands,
        true,
      )
      await writeAuthorizedEgressManifest(runDir, egress)
    }

    const result = {
      profile: profile.id,
      mode: options.execute ? 'executed' : 'planned',
      runDir: projectPath(runDir),
      egress: egressRecord(egress),
      commands: finalCommands,
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log(`${options.execute ? 'Executed' : 'Planned'} ${profile.id}`)
    console.log(`  run: ${projectPath(runDir)}`)
    console.log(`  report: ${projectPath(join(runDir, 'report.md'))}`)
    console.log(`  commands: ${projectPath(join(runDir, 'command-manifest.json'))}`)
    if (egress?.enabled) {
      console.log(`  egress: ${egress.poolId}/${egress.currentNode?.id}`)
    }
    const skipped = finalCommands.filter(command => command.status === 'skipped')
    if (skipped.length > 0) {
      console.log(`  skipped: ${skipped.map(command => command.stepId).join(', ')}`)
    }
  } finally {
    restoreAuthorizedEgressEnv(egress)
  }
}

runProfile(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-profile-runner: ${error.message}`)
  process.exit(1)
})
