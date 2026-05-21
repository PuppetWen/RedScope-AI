#!/usr/bin/env bun
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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

type TargetKind = 'target' | 'repository' | 'artifact'
type RunStatus = 'completed' | 'failed' | 'skipped'

type Options = {
  profileId?: string
  scopePath?: string
  targetsPath?: string
  targetKind: TargetKind
  profilesPath: string
  outputRoot: string
  memoryRoot: string
  batchOutputRoot: string
  semgrepConfig?: string
  dryRun: boolean
  execute: boolean
  confirmActive: boolean
  force: boolean
  json: boolean
  skipReport: boolean
  skipObserve: boolean
  stopOnFailure: boolean
  limit?: number
  startAt: number
}

type WorkflowResult = {
  dryRun?: boolean
  profile?: string
  mode?: string
  runDir?: string
  workflowManifest?: string
  stages?: unknown
  status?: string
  reason?: string
}

type EgressManifest = {
  enabled?: boolean
  poolId?: string
  currentNodeId?: string
  switchCount?: number
  events?: Array<{
    type?: string
    nodeId?: string
    fromNodeId?: string
    toNodeId?: string
    statusCode?: number
    reason?: string
    message?: string
  }>
}

type BatchRunResult = {
  index: number
  target: string
  status: RunStatus
  blocked: boolean
  runDir?: string
  evidenceDir?: string
  workflowManifest?: string
  egress?: {
    enabled: boolean
    poolId?: string
    currentNodeId?: string
    switchCount?: number
    blockEventCount: number
    switchUnavailableCount: number
    eventTypes: Record<string, number>
  }
  command?: string[]
  error?: string
}

type BatchManifest = {
  schemaVersion: 1
  generatedAt: string
  batchId: string
  mode: 'dry-run' | 'planned' | 'executed'
  profile: string
  scopePath: string
  targetListPath: string
  targetKind: TargetKind
  targetCount: number
  processedCount: number
  options: {
    outputRoot: string
    memoryRoot: string
    batchOutputRoot: string
    execute: boolean
    confirmActive: boolean
    reportEnabled: boolean
    observeEnabled: boolean
    startAt: number
    limit?: number
    stopOnFailure: boolean
  }
  safety: {
    variableTargetCount: true
    sequentialExecution: true
    usesExistingProfileWorkflow: true
    freeFormCommandsAllowed: false
    scopeValidatedPerTarget: true
    notes: string[]
  }
  summary: {
    completed: number
    failed: number
    skipped: number
    blocked: number
    evidenceDirs: string[]
  }
  runs: BatchRunResult[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultProfilesPath = envPathFrom(
  ['REDSCOPE_TOOLS_PROFILE_REGISTRY', 'REDSCOPE_PROFILE_REGISTRY'],
  'tools/redscope-run-profiles.json',
)
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
  'tools/outputs',
)
const defaultMemoryRoot = envPathFrom(
  ['REDSCOPE_TOOLS_MEMORY_ROOT', 'REDSCOPE_MEMORY_ROOT'],
  'tools/memory',
)
const defaultBatchOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_BATCH_OUTPUT_ROOT', 'REDSCOPE_BATCH_OUTPUT_ROOT'],
  'tools/outputs/batches',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-batch-runner.ts --profile <id> --scope <scope.json> --targets <targets.txt> [options]

Targets:
  --targets <path>        Newline-delimited targets. Blank lines and # comments are ignored.
  --target-kind <kind>    target | repository | artifact (default: target)
  --start-at <n>          First 1-based target index to process (default: 1)
  --limit <n>             Maximum number of targets to process

Workflow options:
  --profiles <path>       Profile registry path (default: ${defaultProfilesPath})
  --output-root <path>    Run output root (default: ${defaultOutputRoot})
  --memory-root <path>    Local memory root (default: ${defaultMemoryRoot})
  --batch-output <path>   Batch manifest root (default: ${defaultBatchOutputRoot})
  --semgrep-config <path> Local semgrep config forwarded to repository profiles
  --dry-run               Validate each target without writing run directories
  --execute               Execute deterministic internal/tool-backed profile steps
  --confirm-active        Required by active/restricted profile execution
  --skip-report           Do not run report normalization in each workflow
  --skip-observe          Do not ingest each run into local memory
  --force                 Pass --force to each profile workflow
  --stop-on-failure       Stop after the first failed target
  --json                  Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseTargetKind(value: string): TargetKind {
  if (value === 'target' || value === 'repository' || value === 'artifact') {
    return value
  }
  throw new Error('--target-kind must be target, repository, or artifact')
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    targetKind: 'target',
    profilesPath: defaultProfilesPath,
    outputRoot: defaultOutputRoot,
    memoryRoot: defaultMemoryRoot,
    batchOutputRoot: defaultBatchOutputRoot,
    dryRun: false,
    execute: false,
    confirmActive: false,
    force: false,
    json: false,
    skipReport: false,
    skipObserve: false,
    stopOnFailure: false,
    startAt: 1,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--execute') {
      options.execute = true
      continue
    }
    if (arg === '--confirm-active') {
      options.confirmActive = true
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
    if (arg === '--skip-report') {
      options.skipReport = true
      continue
    }
    if (arg === '--skip-observe') {
      options.skipObserve = true
      continue
    }
    if (arg === '--stop-on-failure') {
      options.stopOnFailure = true
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
      case '--targets':
        options.targetsPath = next
        break
      case '--target-kind':
        options.targetKind = parseTargetKind(next)
        break
      case '--profiles':
        options.profilesPath = next
        break
      case '--output-root':
        options.outputRoot = next
        break
      case '--memory-root':
        options.memoryRoot = next
        break
      case '--batch-output':
        options.batchOutputRoot = next
        break
      case '--semgrep-config':
        options.semgrepConfig = next
        break
      case '--limit':
        options.limit = positiveInteger(next, '--limit')
        break
      case '--start-at':
        options.startAt = positiveInteger(next, '--start-at')
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

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function validateOptions(options: Options) {
  if (!options.profileId || !options.scopePath || !options.targetsPath) {
    usage()
  }
}

async function readTargets(targetsPath: string): Promise<string[]> {
  const raw = await readFile(targetsPath, 'utf8')
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

function selectTargets(targets: string[], options: Options): string[] {
  const start = options.startAt - 1
  const end =
    options.limit === undefined ? targets.length : start + options.limit
  return targets.slice(start, end)
}

function sanitizeRunPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function createBatchId(profileId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${sanitizeRunPart(profileId)}`
}

function commandForTarget(
  target: string,
  options: Options,
  paths: {
    scopePath: string
    profilesPath: string
    outputRoot: string
    memoryRoot: string
    semgrepConfig?: string
  },
): string[] {
  if (!options.profileId) usage()
  const args = [
    process.execPath,
    join(scriptDir, 'redscope-workflow.ts'),
    '--profile',
    options.profileId,
    '--scope',
    projectPath(paths.scopePath),
    '--profiles',
    projectPath(paths.profilesPath),
    '--output-root',
    projectPath(paths.outputRoot),
    '--memory-root',
    projectPath(paths.memoryRoot),
    '--json',
  ]

  if (options.targetKind === 'target') args.push('--target', target)
  if (options.targetKind === 'repository') args.push('--repository', target)
  if (options.targetKind === 'artifact') args.push('--artifact', target)
  if (paths.semgrepConfig) {
    args.push('--semgrep-config', projectPath(paths.semgrepConfig))
  }
  if (options.dryRun) args.push('--dry-run')
  if (options.execute) args.push('--execute')
  if (options.confirmActive) args.push('--confirm-active')
  if (options.force) args.push('--force')
  if (options.skipReport) args.push('--skip-report')
  if (options.skipObserve) args.push('--skip-observe')
  return args
}

function displayCommand(command: string[]): string[] {
  return ['bun', 'scripts/redscope-workflow.ts', ...command.slice(2)]
}

function parseJsonOutput<T>(stdout: string): T | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    return JSON.parse(trimmed.slice(start, end + 1)) as T
  }
}

function summarizeEgress(manifest: EgressManifest | undefined) {
  if (!manifest) return undefined
  const eventTypes: Record<string, number> = {}
  for (const event of manifest.events ?? []) {
    const type = event.type ?? 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }
  return {
    enabled: manifest.enabled === true,
    poolId: manifest.poolId,
    currentNodeId: manifest.currentNodeId,
    switchCount: manifest.switchCount,
    blockEventCount: eventTypes['block-detected'] ?? 0,
    switchUnavailableCount: eventTypes['switch-unavailable'] ?? 0,
    eventTypes,
  }
}

function isBlocked(egress: ReturnType<typeof summarizeEgress>): boolean {
  return Boolean(
    egress &&
      (egress.blockEventCount > 0 || egress.switchUnavailableCount > 0),
  )
}

async function runWorkflowForTarget(
  target: string,
  index: number,
  options: Options,
  paths: {
    scopePath: string
    profilesPath: string
    outputRoot: string
    memoryRoot: string
    semgrepConfig?: string
  },
): Promise<BatchRunResult> {
  const command = commandForTarget(target, options, paths)
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  const parsed = parseJsonOutput<WorkflowResult>(stdout)

  if (exitCode !== 0) {
    return {
      index,
      target,
      status: 'failed',
      blocked: false,
      command: displayCommand(command),
      error:
        parsed?.reason ??
        stderr.trim() ??
        stdout.trim() ??
        `workflow exited with code ${exitCode}`,
    }
  }

  const runDir = parsed?.runDir
  const egressManifest = runDir
    ? await readJsonIfExists<EgressManifest>(
        join(resolveProjectPath(runDir), 'egress-manifest.json'),
      )
    : undefined
  const egress = summarizeEgress(egressManifest)

  return {
    index,
    target,
    status: 'completed',
    blocked: isBlocked(egress),
    runDir,
    evidenceDir: runDir,
    workflowManifest: parsed?.workflowManifest,
    egress,
    command: displayCommand(command),
  }
}

function mode(options: Options): BatchManifest['mode'] {
  if (options.dryRun) return 'dry-run'
  return options.execute ? 'executed' : 'planned'
}

function summarizeRuns(runs: BatchRunResult[]): BatchManifest['summary'] {
  return {
    completed: runs.filter(run => run.status === 'completed').length,
    failed: runs.filter(run => run.status === 'failed').length,
    skipped: runs.filter(run => run.status === 'skipped').length,
    blocked: runs.filter(run => run.blocked).length,
    evidenceDirs: runs
      .map(run => run.evidenceDir)
      .filter((path): path is string => Boolean(path)),
  }
}

function createManifest(
  batchId: string,
  options: Options,
  paths: {
    scopePath: string
    targetsPath: string
    outputRoot: string
    memoryRoot: string
    batchOutputRoot: string
  },
  targetCount: number,
  runs: BatchRunResult[],
): BatchManifest {
  if (!options.profileId) usage()
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    batchId,
    mode: mode(options),
    profile: options.profileId,
    scopePath: projectPath(paths.scopePath),
    targetListPath: projectPath(paths.targetsPath),
    targetKind: options.targetKind,
    targetCount,
    processedCount: runs.length,
    options: {
      outputRoot: projectPath(paths.outputRoot),
      memoryRoot: projectPath(paths.memoryRoot),
      batchOutputRoot: projectPath(paths.batchOutputRoot),
      execute: options.execute,
      confirmActive: options.confirmActive,
      reportEnabled: !options.skipReport,
      observeEnabled: !options.skipObserve,
      startAt: options.startAt,
      limit: options.limit,
      stopOnFailure: options.stopOnFailure,
    },
    safety: {
      variableTargetCount: true,
      sequentialExecution: true,
      usesExistingProfileWorkflow: true,
      freeFormCommandsAllowed: false,
      scopeValidatedPerTarget: true,
      notes: [
        'The batch runner accepts any target-list length; it is not fixed to 20 targets.',
        'Each target is passed through the existing RedScope workflow, so profile scope, rate limits, report, and memory stages stay centralized.',
        'Targets run sequentially to preserve the current profile rate-limit and egress-switching assumptions.',
      ],
    },
    summary: summarizeRuns(runs),
    runs,
  }
}

function resolveAndValidatePaths(options: Options) {
  const scopePath = resolveProjectPath(options.scopePath ?? '')
  const targetsPath = resolveProjectPath(options.targetsPath ?? '')
  const profilesPath = resolveProjectPath(options.profilesPath)
  const outputRoot = resolveProjectPath(options.outputRoot)
  const memoryRoot = resolveProjectPath(options.memoryRoot)
  const batchOutputRoot = resolveProjectPath(options.batchOutputRoot)
  const semgrepConfig = options.semgrepConfig
    ? resolveProjectPath(options.semgrepConfig)
    : undefined

  assertInside(scopePath, repoRoot, 'scope path')
  assertInside(targetsPath, repoRoot, 'target list path')
  assertInside(profilesPath, repoRoot, 'profile registry path')
  assertInside(outputRoot, repoRoot, 'output root')
  assertInside(memoryRoot, repoRoot, 'memory root')
  assertInside(batchOutputRoot, repoRoot, 'batch output root')
  if (semgrepConfig) assertInside(semgrepConfig, repoRoot, 'semgrep config')

  return {
    scopePath,
    targetsPath,
    profilesPath,
    outputRoot,
    memoryRoot,
    batchOutputRoot,
    semgrepConfig,
  }
}

async function ensureInputs(paths: {
  scopePath: string
  targetsPath: string
  profilesPath: string
  semgrepConfig?: string
}) {
  for (const [label, path] of [
    ['scope path', paths.scopePath],
    ['target list path', paths.targetsPath],
    ['profile registry path', paths.profilesPath],
  ] as const) {
    if (!(await pathExists(path))) {
      throw new Error(`${label} ${projectPath(path)} does not exist`)
    }
  }
  if (paths.semgrepConfig && !(await pathExists(paths.semgrepConfig))) {
    throw new Error(
      `semgrep config ${projectPath(paths.semgrepConfig)} does not exist`,
    )
  }
}

async function runBatch(options: Options) {
  validateOptions(options)
  const paths = resolveAndValidatePaths(options)
  await ensureInputs(paths)
  const allTargets = await readTargets(paths.targetsPath)
  const selectedTargets = selectTargets(allTargets, options)
  if (selectedTargets.length === 0) {
    throw new Error('target list selection is empty')
  }

  const batchId = createBatchId(options.profileId ?? 'unknown-profile')
  const runs: BatchRunResult[] = []
  for (const [offset, target] of selectedTargets.entries()) {
    const index = options.startAt + offset
    const result = await runWorkflowForTarget(target, index, options, paths)
    runs.push(result)
    if (result.status === 'failed' && options.stopOnFailure) {
      const remaining = selectedTargets.length - offset - 1
      for (let skipped = 0; skipped < remaining; skipped++) {
        const skippedIndex = index + skipped + 1
        runs.push({
          index: skippedIndex,
          target: selectedTargets[offset + skipped + 1] ?? '',
          status: 'skipped',
          blocked: false,
          error: 'skipped because --stop-on-failure was set',
        })
      }
      break
    }
  }

  const manifest = createManifest(
    batchId,
    options,
    paths,
    allTargets.length,
    runs,
  )
  const batchDir = join(paths.batchOutputRoot, batchId)
  const manifestPath = join(batchDir, 'batch-manifest.json')
  if (!options.dryRun) {
    await writeJson(manifestPath, manifest)
  }

  const result = {
    ...manifest,
    batchDir: options.dryRun ? undefined : projectPath(batchDir),
    batchManifest: options.dryRun ? undefined : projectPath(manifestPath),
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Completed RedScope batch ${batchId}`)
  console.log(`  mode: ${manifest.mode}`)
  console.log(`  targets: ${manifest.processedCount}/${manifest.targetCount}`)
  console.log(`  completed: ${manifest.summary.completed}`)
  console.log(`  failed: ${manifest.summary.failed}`)
  console.log(`  blocked: ${manifest.summary.blocked}`)
  if (!options.dryRun) {
    console.log(`  manifest: ${projectPath(manifestPath)}`)
  }
}

const options = parseArgs(process.argv.slice(2))

runBatch(options).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          status: 'failed',
          generatedAt: new Date().toISOString(),
          reason: message,
        },
        null,
        2,
      ),
    )
  } else {
    console.error(`redscope-batch-runner: ${message}`)
  }
  process.exit(1)
})
