#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { envPathFrom } from './redscope-env-config.ts'

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
type FindingStatus = 'confirmed' | 'suspected' | 'informational'

type Options = {
  runPath?: string
  latest: boolean
  all: boolean
  profileId?: string
  outputRoot: string
  memoryRoot: string
  dryRun: boolean
  json: boolean
}

type RunManifest = {
  generatedAt?: string
  status?: string
  profile?: {
    id?: string
    name?: string
    riskLevel?: string
    reportTemplate?: string
  }
  authorization?: {
    scopePath?: string
    owner?: string
    authorizedBy?: string
    reference?: string | null
    validFrom?: string
    validTo?: string
  }
  target?: Record<string, unknown>
  effectiveRateLimits?: Record<string, unknown>
  stopConditions?: string[]
}

type CommandManifest = {
  stepId?: string
  tool?: string
  kind?: string
  argv?: string[]
  cwd?: string
  outputFiles?: string[]
  status?: string
  reason?: string
  exitCode?: number
}

type Finding = {
  id?: string
  title?: string
  severity?: Severity
  status?: FindingStatus
  category?: string
  target?: string
  sourceTool?: string
}

type FindingSummary = {
  total?: number
  highestSeverity?: Severity | 'none'
  bySeverity?: Partial<Record<Severity, number>>
  byStatus?: Partial<Record<FindingStatus, number>>
}

type FindingBundle = {
  generatedAt?: string
  summary?: FindingSummary
  findings?: Finding[]
  limitations?: string[]
  warnings?: string[]
}

type EvidenceIndex = {
  evidence?: Array<{
    id?: string
    kind?: string
    path?: string
    description?: string
    sha256?: string
    bytes?: number
  }>
}

type RunObservation = {
  id: string
  runDir: string
  observedAt: string
  runGeneratedAt?: string
  runStatus?: string
  profile: {
    id?: string
    name?: string
    riskLevel?: string
  }
  target: {
    kind?: string
    value: string
    host?: string
    url?: string
    repositoryPath?: string
    artifactPath?: string
    matchedBy: string[]
  }
  authorization: {
    owner?: string
    reference?: string | null
    validFrom?: string
    validTo?: string
    scopePath?: string
  }
  summary: {
    findingsTotal: number
    highestSeverity: Severity | 'none'
    bySeverity: Record<Severity, number>
    byStatus: Record<FindingStatus, number>
    limitations: string[]
    warnings: string[]
    evidenceCount: number
  }
  commandSummary: {
    total: number
    planned: number
    executed: number
    skipped: number
    failed: number
  }
  artifacts: {
    report?: string
    findings?: string
    evidenceIndex?: string
    commandManifest?: string
  }
}

type AssetMemory = {
  id: string
  kind: string
  value: string
  owner?: string
  firstSeen: string
  lastSeen: string
  profiles: string[]
  scopeMatches: string[]
  runSummaries: Array<{
    runId: string
    runDir: string
    profile?: string
    highestSeverity: Severity | 'none'
    findingsTotal: number
  }>
}

type DecisionMemory = {
  id: string
  runId: string
  runDir: string
  observedAt: string
  type: 'authorization' | 'execution-mode' | 'profile-step'
  profile?: string
  stepId?: string
  tool?: string
  outcome: string
  rationale: string
}

type ToolOutputMemory = {
  id: string
  runId: string
  runDir: string
  observedAt: string
  stepId: string
  tool: string
  status: string
  exitCode?: number
  outputFiles: string[]
}

type LessonMemory = {
  id: string
  category: string
  title: string
  lesson: string
  confidence: 'low' | 'medium' | 'high'
  firstSeen: string
  lastSeen: string
  evidenceRuns: string[]
}

type RedScopeMemory = {
  schemaVersion: 1
  generatedAt: string
  updatedAt: string
  policy: {
    localOnly: true
    memoryRoot: string
    sourceRoot: string
    storesRawSecrets: false
    storesResponseBodies: false
    notes: string[]
  }
  runs: RunObservation[]
  assets: AssetMemory[]
  decisions: DecisionMemory[]
  toolOutputs: ToolOutputMemory[]
  lessons: LessonMemory[]
}

type IngestedRun = {
  run: RunObservation
  assets: AssetMemory[]
  decisions: DecisionMemory[]
  toolOutputs: ToolOutputMemory[]
  lessons: LessonMemory[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
  'tools/outputs',
)
const defaultMemoryRoot = envPathFrom(
  ['REDSCOPE_TOOLS_MEMORY_ROOT', 'REDSCOPE_MEMORY_ROOT'],
  'tools/memory',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-observability.ts --run <tools/outputs/profile/run-id> [options]
  bun run scripts/redscope-observability.ts --latest --profile <id> [options]
  bun run scripts/redscope-observability.ts --all [options]

Options:
  --output-root <path>     Run output root (default: ${defaultOutputRoot})
  --memory-root <path>     Local memory root (default: ${defaultMemoryRoot})
  --dry-run                Build observations without writing memory files
  --json                   Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    latest: false,
    all: false,
    outputRoot: defaultOutputRoot,
    memoryRoot: defaultMemoryRoot,
    dryRun: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--latest') {
      options.latest = true
      continue
    }
    if (arg === '--all') {
      options.all = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--run':
        options.runPath = next
        break
      case '--profile':
        options.profileId = next
        break
      case '--output-root':
        options.outputRoot = next
        break
      case '--memory-root':
        options.memoryRoot = next
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  return JSON.parse(raw) as T
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined
  return readJsonFile<T>(path)
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${prefix}:${hash}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim())
    : []
}

function numberFromSummary(
  summary: FindingSummary | undefined,
  severity: Severity,
): number {
  const value = summary?.bySeverity?.[severity]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function statusCount(
  summary: FindingSummary | undefined,
  status: FindingStatus,
): number {
  const value = summary?.byStatus?.[status]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function targetFromRun(run: RunManifest): RunObservation['target'] {
  const target = run.target ?? {}
  const kind = stringValue(target, 'kind')
  const raw = stringValue(target, 'raw')
  const host = stringValue(target, 'normalizedHost')
  const url = stringValue(target, 'normalizedUrl')
  const repositoryPath = stringValue(target, 'repositoryPath')
  const artifactPath = stringValue(target, 'artifactPath')
  const value = url ?? repositoryPath ?? raw ?? artifactPath ?? host ?? 'unknown'
  return {
    kind,
    value,
    host,
    url,
    repositoryPath,
    artifactPath,
    matchedBy: stringList(target.matchedBy),
  }
}

function commandSummary(commands: CommandManifest[]): RunObservation['commandSummary'] {
  const summary = {
    total: commands.length,
    planned: 0,
    executed: 0,
    skipped: 0,
    failed: 0,
  }
  for (const command of commands) {
    if (command.status === 'planned') summary.planned++
    if (command.status === 'executed') summary.executed++
    if (command.status === 'skipped') summary.skipped++
    if (command.status === 'failed') summary.failed++
  }
  return summary
}

async function existingArtifactPath(
  runDir: string,
  name: string,
): Promise<string | undefined> {
  const path = join(runDir, name)
  return (await pathExists(path)) ? projectPath(path) : undefined
}

async function observeRun(runDir: string, observedAt: string): Promise<IngestedRun> {
  const run = await readJsonFile<RunManifest>(join(runDir, 'run.json'))
  const commands =
    (await readJsonIfExists<CommandManifest[]>(join(runDir, 'command-manifest.json'))) ?? []
  const findings = await readJsonIfExists<FindingBundle>(join(runDir, 'findings.json'))
  const evidenceIndex = await readJsonIfExists<EvidenceIndex>(
    join(runDir, 'evidence-index.json'),
  )
  const target = targetFromRun(run)
  const runDirLabel = projectPath(runDir)
  const runId = stableId('run', runDirLabel)
  const findingSummary = findings?.summary
  const observation: RunObservation = {
    id: runId,
    runDir: runDirLabel,
    observedAt,
    runGeneratedAt: run.generatedAt,
    runStatus: run.status,
    profile: {
      id: run.profile?.id,
      name: run.profile?.name,
      riskLevel: run.profile?.riskLevel,
    },
    target,
    authorization: {
      owner: run.authorization?.owner,
      reference: run.authorization?.reference,
      validFrom: run.authorization?.validFrom,
      validTo: run.authorization?.validTo,
      scopePath: run.authorization?.scopePath,
    },
    summary: {
      findingsTotal: findingSummary?.total ?? findings?.findings?.length ?? 0,
      highestSeverity: findingSummary?.highestSeverity ?? 'none',
      bySeverity: {
        info: numberFromSummary(findingSummary, 'info'),
        low: numberFromSummary(findingSummary, 'low'),
        medium: numberFromSummary(findingSummary, 'medium'),
        high: numberFromSummary(findingSummary, 'high'),
        critical: numberFromSummary(findingSummary, 'critical'),
      },
      byStatus: {
        confirmed: statusCount(findingSummary, 'confirmed'),
        suspected: statusCount(findingSummary, 'suspected'),
        informational: statusCount(findingSummary, 'informational'),
      },
      limitations: findings?.limitations ?? [],
      warnings: findings?.warnings ?? [],
      evidenceCount: evidenceIndex?.evidence?.length ?? 0,
    },
    commandSummary: commandSummary(commands),
    artifacts: {
      report: await existingArtifactPath(runDir, 'report.md'),
      findings: await existingArtifactPath(runDir, 'findings.json'),
      evidenceIndex: await existingArtifactPath(runDir, 'evidence-index.json'),
      commandManifest: await existingArtifactPath(runDir, 'command-manifest.json'),
    },
  }

  return {
    run: observation,
    assets: buildAssets(observation, observedAt),
    decisions: buildDecisions(observation, commands, observedAt),
    toolOutputs: buildToolOutputs(observation, commands, observedAt),
    lessons: buildLessons(observation, findings, commands, observedAt),
  }
}

function buildAssets(
  run: RunObservation,
  observedAt: string,
): AssetMemory[] {
  const kind = run.target.kind ?? inferAssetKind(run.target.value)
  const id = stableId('asset', kind, run.target.value)
  return [
    {
      id,
      kind,
      value: run.target.value,
      owner: run.authorization.owner,
      firstSeen: observedAt,
      lastSeen: observedAt,
      profiles: run.profile.id ? [run.profile.id] : [],
      scopeMatches: run.target.matchedBy,
      runSummaries: [
        {
          runId: run.id,
          runDir: run.runDir,
          profile: run.profile.id,
          highestSeverity: run.summary.highestSeverity,
          findingsTotal: run.summary.findingsTotal,
        },
      ],
    },
  ]
}

function inferAssetKind(value: string): string {
  if (/^https?:\/\//i.test(value)) return 'url'
  if (/\.(log|json|jsonl|csv|txt|pcap|pcapng|evtx|zip|tar|gz|exe|dll|sys|hiv|hive|dat)$/i.test(value)) return 'artifact'
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith('.')) return 'repository'
  if (value.includes('.')) return 'domain'
  return 'unknown'
}

function buildDecisions(
  run: RunObservation,
  commands: CommandManifest[],
  observedAt: string,
): DecisionMemory[] {
  const decisions: DecisionMemory[] = [
    {
      id: stableId('decision', run.id, 'authorization'),
      runId: run.id,
      runDir: run.runDir,
      observedAt,
      type: 'authorization',
      profile: run.profile.id,
      outcome: run.authorization.reference ? 'reference-recorded' : 'scope-recorded',
      rationale: `Run used scope ${run.authorization.scopePath ?? 'unknown'} for owner ${run.authorization.owner ?? 'unknown'}.`,
    },
    {
      id: stableId('decision', run.id, 'execution-mode', run.runStatus ?? 'unknown'),
      runId: run.id,
      runDir: run.runDir,
      observedAt,
      type: 'execution-mode',
      profile: run.profile.id,
      outcome: run.runStatus ?? 'unknown',
      rationale:
        run.runStatus === 'executed'
          ? 'Profile steps were executed under the deterministic runner.'
          : 'Profile remained plan-only or did not record an executed status.',
    },
  ]

  for (const command of commands) {
    const stepId = command.stepId ?? 'unknown-step'
    decisions.push({
      id: stableId('decision', run.id, stepId, command.status ?? 'unknown'),
      runId: run.id,
      runDir: run.runDir,
      observedAt,
      type: 'profile-step',
      profile: run.profile.id,
      stepId,
      tool: command.tool ?? command.kind,
      outcome: command.status ?? 'unknown',
      rationale:
        command.reason ??
        `${stepId} recorded status ${command.status ?? 'unknown'} in command-manifest.json.`,
    })
  }

  return decisions
}

function buildToolOutputs(
  run: RunObservation,
  commands: CommandManifest[],
  observedAt: string,
): ToolOutputMemory[] {
  const outputs: ToolOutputMemory[] = []
  for (const command of commands) {
    const outputFiles = stringList(command.outputFiles)
    if (outputFiles.length === 0) continue
    const stepId = command.stepId ?? 'unknown-step'
    outputs.push({
      id: stableId('tool-output', run.id, stepId, outputFiles.join('|')),
      runId: run.id,
      runDir: run.runDir,
      observedAt,
      stepId,
      tool: command.tool ?? command.kind ?? 'internal',
      status: command.status ?? 'unknown',
      exitCode: command.exitCode,
      outputFiles,
    })
  }
  return outputs
}

function buildLessons(
  run: RunObservation,
  findings: FindingBundle | undefined,
  commands: CommandManifest[],
  observedAt: string,
): LessonMemory[] {
  const lessons: LessonMemory[] = []
  const addLesson = (
    category: string,
    title: string,
    lesson: string,
    confidence: LessonMemory['confidence'],
  ) => {
    lessons.push({
      id: stableId('lesson', category, title, lesson),
      category,
      title,
      lesson,
      confidence,
      firstSeen: observedAt,
      lastSeen: observedAt,
      evidenceRuns: [run.id],
    })
  }

  if (run.runStatus !== 'executed') {
    addLesson(
      'workflow',
      'Plan-only runs need execution before evidence-backed findings',
      'A plan-only run is useful for review, but findings should not be treated as observed evidence until the profile is executed or raw outputs are attached.',
      'high',
    )
  }

  for (const command of commands) {
    if (command.status === 'skipped') {
      addLesson(
        'tooling',
        `Skipped step: ${command.stepId ?? 'unknown-step'}`,
        command.reason ??
          'Skipped profile steps should be resolved before relying on coverage claims.',
        'medium',
      )
    }
    if (command.status === 'failed') {
      addLesson(
        'tooling',
        `Failed step: ${command.stepId ?? 'unknown-step'}`,
        'Failed tool steps should be triaged before report delivery, including exit code, stderr, and scope impact.',
        'high',
      )
    }
  }

  const categories = new Set(
    (findings?.findings ?? [])
      .map(finding => finding.category)
      .filter((category): category is string => Boolean(category)),
  )

  if (categories.has('security-header-baseline')) {
    addLesson(
      'web-baseline',
      'Missing security headers require endpoint context',
      'Treat missing header observations as baseline indicators until the owner confirms endpoint role, compensating controls, and full application behavior.',
      'high',
    )
  }
  if (categories.has('secret-scanning')) {
    addLesson(
      'repository-review',
      'Secret findings need rotation-first remediation',
      'Confirmed repository secrets should trigger revoke or rotate actions before history cleanup and prevention control work.',
      'high',
    )
  }
  if (categories.has('static-analysis')) {
    addLesson(
      'repository-review',
      'Static analysis needs reachability triage',
      'SAST findings should be reviewed for reachability, exploitability, and regression coverage before severity is finalized.',
      'medium',
    )
  }
  if (categories.has('http-probe')) {
    addLesson(
      'asset-inventory',
      'HTTP probes feed asset inventory before vulnerability claims',
      'HTTP probe observations should be used to refine asset inventory and prioritization unless paired with a confirmed finding.',
      'medium',
    )
  }
  if (categories.has('nuclei-low-impact')) {
    addLesson(
      'active-validation',
      'Low-impact template matches still need manual confirmation',
      'Nuclei low or info matches should remain suspected or informational until an authorized analyst confirms the condition.',
      'medium',
    )
  }
  if (categories.has('threat-trace-artifact')) {
    addLesson(
      'threat-trace',
      'Artifact summaries preserve locality and avoid raw log copying',
      'Threat-trace artifact runs should use local summaries, hashes, indicator counts, and evidence references before sharing any raw incident data.',
      'high',
    )
  }
  if (categories.has('threat-trace-indicator')) {
    addLesson(
      'threat-trace',
      'Indicators need enrichment before containment decisions',
      'Extracted IOCs are triage leads; validate and enrich them against trusted internal telemetry before blocking, attribution, or escalation.',
      'medium',
    )
  }
  if (categories.has('threat-trace-keyword')) {
    addLesson(
      'threat-trace',
      'Keyword hits are weak signals',
      'Threat-trace keyword matches should be correlated with timestamps, identities, hosts, and network telemetry before they become incident facts.',
      'medium',
    )
  }
  if (categories.has('threat-trace-structured-artifact')) {
    addLesson(
      'threat-trace',
      'Structured artifacts should stay summarized until reviewed',
      'SIEM exports, STIX bundles, EVTX files, PE files, registry hives, and case archives should be triaged through counts, schema hints, hashes, and bounded parser metadata before raw evidence is shared or extracted.',
      'medium',
    )
  }
  if (categories.has('threat-trace-evtx-metadata')) {
    addLesson(
      'threat-trace',
      'EVTX BinXML metadata is a triage signal',
      'EVTX BinXML token and template metadata helps scope forensic review, but event bodies should remain in approved forensic tools until disclosure boundaries are confirmed.',
      'medium',
    )
  }
  if (categories.has('threat-trace-pe-metadata')) {
    addLesson(
      'threat-trace',
      'PE files need controlled binary review',
      'PE metadata is a triage layer; review binaries in approved malware-analysis or software-inventory tooling before drawing execution or maliciousness conclusions.',
      'medium',
    )
  }
  if (categories.has('threat-trace-registry-hive')) {
    addLesson(
      'threat-trace',
      'Registry hives need forensic parsing controls',
      'Registry hive base-block and hbin metadata can bound evidence shape, but raw keys and values should be opened only in approved forensic workflows.',
      'medium',
    )
  }
  if (categories.has('threat-trace-archive-warning')) {
    addLesson(
      'threat-trace',
      'Archive bundles need controlled handling',
      'Archives with encrypted or traversal-style entries should be opened only in a controlled forensic workspace after provenance and scope are confirmed.',
      'high',
    )
  }

  return lessons
}

function mergeStringLists(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort()
}

function upsertById<T extends { id: string }>(
  current: T[],
  incoming: T[],
  merge: (existing: T, item: T) => T = (_existing, item) => item,
): T[] {
  const map = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) {
    const existing = map.get(item.id)
    map.set(item.id, existing ? merge(existing, item) : item)
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function mergeAsset(existing: AssetMemory, item: AssetMemory): AssetMemory {
  return {
    ...item,
    firstSeen: existing.firstSeen < item.firstSeen ? existing.firstSeen : item.firstSeen,
    lastSeen: existing.lastSeen > item.lastSeen ? existing.lastSeen : item.lastSeen,
    profiles: mergeStringLists(existing.profiles, item.profiles),
    scopeMatches: mergeStringLists(existing.scopeMatches, item.scopeMatches),
    runSummaries: upsertById(
      existing.runSummaries.map(summary => ({ id: summary.runId, ...summary })),
      item.runSummaries.map(summary => ({ id: summary.runId, ...summary })),
    ).map(({ id: _id, ...summary }) => summary),
  }
}

function mergeLesson(existing: LessonMemory, item: LessonMemory): LessonMemory {
  return {
    ...item,
    firstSeen: existing.firstSeen < item.firstSeen ? existing.firstSeen : item.firstSeen,
    lastSeen: existing.lastSeen > item.lastSeen ? existing.lastSeen : item.lastSeen,
    evidenceRuns: mergeStringLists(existing.evidenceRuns, item.evidenceRuns),
    confidence: confidenceRank(existing.confidence) > confidenceRank(item.confidence)
      ? existing.confidence
      : item.confidence,
  }
}

function confidenceRank(confidence: LessonMemory['confidence']): number {
  switch (confidence) {
    case 'low':
      return 1
    case 'medium':
      return 2
    case 'high':
      return 3
  }
}

function emptyMemory(memoryRoot: string, outputRoot: string, now: string): RedScopeMemory {
  return {
    schemaVersion: 1,
    generatedAt: now,
    updatedAt: now,
    policy: {
      localOnly: true,
      memoryRoot: projectPath(memoryRoot),
      sourceRoot: projectPath(outputRoot),
      storesRawSecrets: false,
      storesResponseBodies: false,
      notes: [
        'This file is a project-local RedScope memory index.',
        'It stores summaries, relationships, and lessons only.',
        'Raw secrets, payloads, and response bodies must stay out of this memory document.',
      ],
    },
    runs: [],
    assets: [],
    decisions: [],
    toolOutputs: [],
    lessons: [],
  }
}

async function readMemory(
  memoryPath: string,
  memoryRoot: string,
  outputRoot: string,
  now: string,
): Promise<RedScopeMemory> {
  const existing = await readJsonIfExists<RedScopeMemory>(memoryPath)
  if (!existing || existing.schemaVersion !== 1) {
    return emptyMemory(memoryRoot, outputRoot, now)
  }
  return {
    ...existing,
    updatedAt: now,
    policy: {
      ...existing.policy,
      memoryRoot: projectPath(memoryRoot),
      sourceRoot: projectPath(outputRoot),
      localOnly: true,
      storesRawSecrets: false,
      storesResponseBodies: false,
    },
  }
}

function mergeMemory(memory: RedScopeMemory, ingested: IngestedRun[]): RedScopeMemory {
  const runs = ingested.map(item => item.run)
  const assets = ingested.flatMap(item => item.assets)
  const decisions = ingested.flatMap(item => item.decisions)
  const toolOutputs = ingested.flatMap(item => item.toolOutputs)
  const lessons = ingested.flatMap(item => item.lessons)

  return {
    ...memory,
    runs: upsertById(memory.runs, runs),
    assets: upsertById(memory.assets, assets, mergeAsset),
    decisions: upsertById(memory.decisions, decisions),
    toolOutputs: upsertById(memory.toolOutputs, toolOutputs),
    lessons: upsertById(memory.lessons, lessons, mergeLesson),
  }
}

async function findLatestRun(outputRoot: string, profileId: string): Promise<string> {
  const profileRoot = resolve(outputRoot, profileId)
  assertInside(profileRoot, outputRoot, 'profile output root')
  if (!(await pathExists(profileRoot))) {
    throw new Error(`${projectPath(profileRoot)} does not exist`)
  }

  const entries = await readdir(profileRoot, { withFileTypes: true })
  const candidates: Array<{ path: string; generatedAt: number; mtime: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = join(profileRoot, entry.name)
    const runPath = join(runDir, 'run.json')
    if (!(await pathExists(runPath))) continue
    let generatedAt = 0
    try {
      const run = await readJsonFile<RunManifest>(runPath)
      generatedAt = Date.parse(run.generatedAt ?? '')
      if (!Number.isFinite(generatedAt)) generatedAt = 0
    } catch {
      generatedAt = 0
    }
    const info = await stat(runDir)
    candidates.push({ path: runDir, generatedAt, mtime: info.mtimeMs })
  }

  candidates.sort((a, b) => {
    if (b.generatedAt !== a.generatedAt) return b.generatedAt - a.generatedAt
    return b.mtime - a.mtime
  })

  const latest = candidates[0]?.path
  if (!latest) throw new Error(`no runs found under ${projectPath(profileRoot)}`)
  return latest
}

async function collectRunDirs(outputRoot: string): Promise<string[]> {
  const dirs: string[] = []
  async function walk(dir: string) {
    const runPath = join(dir, 'run.json')
    if (await pathExists(runPath)) {
      dirs.push(dir)
      return
    }
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await walk(join(dir, entry.name))
    }
  }

  if (await pathExists(outputRoot)) await walk(outputRoot)
  return dirs.sort()
}

async function resolveRunDirs(options: Options, outputRoot: string): Promise<string[]> {
  const selected = [options.runPath ? 1 : 0, options.latest ? 1 : 0, options.all ? 1 : 0]
    .reduce((total, item) => total + item, 0)
  if (selected !== 1) usage()

  if (options.runPath) {
    const runDir = resolveProjectPath(options.runPath)
    assertInside(runDir, outputRoot, 'run directory')
    return [runDir]
  }

  if (options.latest) {
    if (!options.profileId) usage()
    return [await findLatestRun(outputRoot, options.profileId)]
  }

  return collectRunDirs(outputRoot)
}

async function runObservability(options: Options) {
  const outputRoot = resolveProjectPath(options.outputRoot)
  const memoryRoot = resolveProjectPath(options.memoryRoot)
  assertInside(outputRoot, repoRoot, 'output root')
  assertInside(memoryRoot, repoRoot, 'memory root')

  const now = new Date().toISOString()
  const runDirs = await resolveRunDirs(options, outputRoot)
  const ingested: IngestedRun[] = []
  for (const runDir of runDirs) {
    if (!(await pathExists(join(runDir, 'run.json')))) {
      throw new Error(`${projectPath(runDir)} is missing run.json`)
    }
    ingested.push(await observeRun(runDir, now))
  }

  const memoryPath = join(memoryRoot, 'redscope-memory.json')
  const existing = await readMemory(memoryPath, memoryRoot, outputRoot, now)
  const memory = mergeMemory(existing, ingested)

  if (!options.dryRun) {
    await writeJson(memoryPath, memory)
  }

  const result = {
    dryRun: options.dryRun,
    memoryPath: projectPath(memoryPath),
    ingestedRuns: ingested.length,
    totals: {
      runs: memory.runs.length,
      assets: memory.assets.length,
      decisions: memory.decisions.length,
      toolOutputs: memory.toolOutputs.length,
      lessons: memory.lessons.length,
    },
    runDirs: ingested.map(item => item.run.runDir),
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`${options.dryRun ? 'Prepared' : 'Updated'} RedScope memory`)
  console.log(`  memory: ${projectPath(memoryPath)}`)
  console.log(`  ingested runs: ${ingested.length}`)
  console.log(`  assets: ${memory.assets.length}`)
  console.log(`  decisions: ${memory.decisions.length}`)
  console.log(`  lessons: ${memory.lessons.length}`)
}

runObservability(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-observability: ${error.message}`)
  process.exit(1)
})
