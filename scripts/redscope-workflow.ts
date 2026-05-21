#!/usr/bin/env bun
import { constants as fsConstants } from 'node:fs'
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
import { ensureRedScopeSourcesFresh } from './redscope-source-updater.ts'
import { envPathFrom } from './redscope-env-config.ts'

type Options = {
  profileId?: string
  scopePath?: string
  target?: string
  repository?: string
  artifact?: string
  profilesPath: string
  outputRoot: string
  memoryRoot: string
  semgrepConfig?: string
  dryRun: boolean
  execute: boolean
  confirmActive: boolean
  force: boolean
  json: boolean
  skipReport: boolean
  skipObserve: boolean
}

type CommandStatus = 'planned' | 'executed' | 'skipped' | 'failed'

type CommandSummary = Record<CommandStatus, number> & {
  total: number
}

type ProfileStageResult = {
  dryRun?: boolean
  profile?: string
  mode?: string
  runDir?: string
  target?: unknown
  effectiveRateLimits?: unknown
  commands?: unknown
  stopConditions?: string[]
}

type ReportStageResult = {
  dryRun?: boolean
  runDir?: string
  generatedFiles?: Record<string, string>
  summary?: unknown
  warnings?: string[]
}

type ObserveStageResult = {
  dryRun?: boolean
  memoryPath?: string
  ingestedRuns?: number
  totals?: Record<string, number>
  runDirs?: string[]
}

type StageSummary = {
  status: 'completed' | 'skipped'
  command?: string[]
  reason?: string
  result?: Record<string, unknown>
}

function profileRequiresSourceCache(profileId: string | undefined): boolean {
  return (
    profileId !== 'authorized-low-impact-validator' &&
    profileId !== 'authorized-business-logic-validation' &&
    profileId !== 'authorized-stateful-business-logic-validation'
  )
}

type WorkflowManifest = {
  schemaVersion: 1
  generatedAt: string
  runDir: string
  mode: 'planned' | 'executed'
  profile: string
  options: {
    scopePath: string
    outputRoot: string
    memoryRoot: string
    execute: boolean
    confirmActive: boolean
    reportEnabled: boolean
    observeEnabled: boolean
  }
  safety: {
    deterministicProfilesOnly: true
    freeFormCommandsAllowed: false
    executeFlagRequiredForTools: true
    activeConfirmationPassed: boolean
    storesRawSecrets: false
    storesResponseBodies: false
    notes: string[]
  }
  stages: {
    profile: StageSummary
    report: StageSummary
    observe: StageSummary
  }
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

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-workflow.ts --profile <id> --scope <scope.json> --target <url|domain|company> [options]
  bun run scripts/redscope-workflow.ts --profile repo-secret-and-sast --scope <scope.json> --repository <path> [options]
  bun run scripts/redscope-workflow.ts --profile threat-trace-artifact-review --scope <scope.json> --artifact <path> [options]

Workflow:
  default                  Plan a profile run, then write report and memory artifacts
  --dry-run                Validate and print the profile plan without writing files
  --execute                Execute deterministic internal/tool-backed profile steps
  --confirm-active         Required by profile runner when executing active/restricted profiles

Options:
  --profiles <path>        Profile registry path (default: ${defaultProfilesPath})
  --output-root <path>     Run output root (default: ${defaultOutputRoot})
  --memory-root <path>     Local memory root (default: ${defaultMemoryRoot})
  --semgrep-config <path>  Local semgrep config for repo-secret-and-sast execution
  --skip-report            Do not run report normalization after profile planning/execution
  --skip-observe           Do not ingest the run into local memory
  --force                  Pass --force to the profile runner
  --json                   Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    profilesPath: defaultProfilesPath,
    outputRoot: defaultOutputRoot,
    memoryRoot: defaultMemoryRoot,
    dryRun: false,
    execute: false,
    confirmActive: false,
    force: false,
    json: false,
    skipReport: false,
    skipObserve: false,
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
      case '--memory-root':
        options.memoryRoot = next
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonOutput<T>(stage: string, stdout: string): T {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error(`${stage} returned empty stdout`)

  try {
    return JSON.parse(trimmed) as T
  } catch (firstError) {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T
      } catch {
        // Fall through to the original parse error for a clearer message.
      }
    }
    const message =
      firstError instanceof Error ? firstError.message : String(firstError)
    throw new Error(`${stage} did not return JSON: ${message}`)
  }
}

function summarizeCommands(commands: unknown): CommandSummary {
  const summary: CommandSummary = {
    total: 0,
    planned: 0,
    executed: 0,
    skipped: 0,
    failed: 0,
  }
  if (!Array.isArray(commands)) return summary

  summary.total = commands.length
  for (const command of commands) {
    if (!isRecord(command)) continue
    const status = command.status
    if (
      status === 'planned' ||
      status === 'executed' ||
      status === 'skipped' ||
      status === 'failed'
    ) {
      summary[status]++
    }
  }
  return summary
}

function commandFor(scriptName: string, args: string[]): string[] {
  return ['bun', `scripts/${scriptName}`, ...args]
}

async function runStage<T>(
  stage: string,
  scriptName: string,
  args: string[],
): Promise<{
  parsed: T
  displayCommand: string[]
  stderr: string
}> {
  const scriptPath = join(scriptDir, scriptName)
  const proc = Bun.spawn([process.execPath, scriptPath, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  const displayCommand = commandFor(scriptName, args)

  if (exitCode !== 0) {
    const stderrText = stderr.trim()
    const stdoutText = stdout.trim()
    const detail = stderrText || stdoutText || `exit code ${exitCode}`
    throw new Error(`${stage} failed: ${detail}`)
  }

  return {
    parsed: parseJsonOutput<T>(stage, stdout),
    displayCommand,
    stderr,
  }
}

function validateOptions(options: Options) {
  if (!options.profileId || !options.scopePath) usage()
  const selectedTargets = [options.target, options.repository, options.artifact]
    .filter(Boolean).length
  if (selectedTargets > 1) {
    throw new Error('choose only one of --target, --repository, or --artifact')
  }
}

function buildProfileArgs(
  options: Options,
  paths: {
    scopePath: string
    profilesPath: string
    outputRoot: string
    repository?: string
    artifact?: string
    semgrepConfig?: string
  },
): string[] {
  if (!options.profileId) usage()
  const args = [
    '--profile',
    options.profileId,
    '--scope',
    projectPath(paths.scopePath),
    '--profiles',
    projectPath(paths.profilesPath),
    '--output-root',
    projectPath(paths.outputRoot),
    '--json',
  ]

  if (options.target) args.push('--target', options.target)
  if (paths.repository) args.push('--repository', projectPath(paths.repository))
  if (paths.artifact) args.push('--artifact', projectPath(paths.artifact))
  if (paths.semgrepConfig) {
    args.push('--semgrep-config', projectPath(paths.semgrepConfig))
  }
  if (options.dryRun) args.push('--dry-run')
  if (options.execute) args.push('--execute')
  if (options.confirmActive) args.push('--confirm-active')
  if (options.force) args.push('--force')
  return args
}

function summarizeProfileResult(
  result: ProfileStageResult,
): Record<string, unknown> {
  return {
    dryRun: Boolean(result.dryRun),
    profile: result.profile,
    mode: result.mode,
    runDir: result.runDir,
    target: result.target,
    effectiveRateLimits: result.effectiveRateLimits,
    commandSummary: summarizeCommands(result.commands),
    stopConditions: result.stopConditions,
  }
}

function summarizeReportResult(
  result: ReportStageResult,
): Record<string, unknown> {
  return {
    dryRun: Boolean(result.dryRun),
    runDir: result.runDir,
    generatedFiles: result.generatedFiles,
    summary: result.summary,
    warningCount: result.warnings?.length ?? 0,
  }
}

function summarizeObserveResult(
  result: ObserveStageResult,
): Record<string, unknown> {
  return {
    dryRun: Boolean(result.dryRun),
    memoryPath: result.memoryPath,
    ingestedRuns: result.ingestedRuns,
    totals: result.totals,
    runDirs: result.runDirs,
  }
}

function resolveAndValidatePaths(options: Options) {
  const profilesPath = resolveProjectPath(options.profilesPath)
  const scopePath = resolveProjectPath(options.scopePath ?? '')
  const outputRoot = resolveProjectPath(options.outputRoot)
  const memoryRoot = resolveProjectPath(options.memoryRoot)
  const repository = options.repository
    ? resolveProjectPath(options.repository)
    : undefined
  const artifact = options.artifact
    ? resolveProjectPath(options.artifact)
    : undefined
  const semgrepConfig = options.semgrepConfig
    ? resolveProjectPath(options.semgrepConfig)
    : undefined

  assertInside(profilesPath, repoRoot, 'profile registry path')
  assertInside(scopePath, repoRoot, 'scope path')
  assertInside(outputRoot, repoRoot, 'output root')
  assertInside(memoryRoot, repoRoot, 'memory root')
  if (repository) assertInside(repository, repoRoot, 'repository target')
  if (artifact) assertInside(artifact, repoRoot, 'artifact target')
  if (semgrepConfig) assertInside(semgrepConfig, repoRoot, 'semgrep config')

  return {
    profilesPath,
    scopePath,
    outputRoot,
    memoryRoot,
    repository,
    artifact,
    semgrepConfig,
  }
}

async function ensureInputFiles(paths: {
  profilesPath: string
  scopePath: string
  semgrepConfig?: string
}) {
  if (!(await pathExists(paths.profilesPath))) {
    throw new Error(`${projectPath(paths.profilesPath)} does not exist`)
  }
  if (!(await pathExists(paths.scopePath))) {
    throw new Error(`${projectPath(paths.scopePath)} does not exist`)
  }
  if (paths.semgrepConfig && !(await pathExists(paths.semgrepConfig))) {
    throw new Error(`${projectPath(paths.semgrepConfig)} does not exist`)
  }
}

function profileRunDir(result: ProfileStageResult): string {
  if (!result.runDir) {
    throw new Error('profile stage did not return runDir')
  }
  return result.runDir
}

function workflowManifest(
  options: Options,
  paths: ReturnType<typeof resolveAndValidatePaths>,
  runDir: string,
  stages: WorkflowManifest['stages'],
): WorkflowManifest {
  if (!options.profileId) usage()
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runDir: projectPath(runDir),
    mode: options.execute ? 'executed' : 'planned',
    profile: options.profileId,
    options: {
      scopePath: projectPath(paths.scopePath),
      outputRoot: projectPath(paths.outputRoot),
      memoryRoot: projectPath(paths.memoryRoot),
      execute: options.execute,
      confirmActive: options.confirmActive,
      reportEnabled: !options.skipReport,
      observeEnabled: !options.skipObserve,
    },
    safety: {
      deterministicProfilesOnly: true,
      freeFormCommandsAllowed: false,
      executeFlagRequiredForTools: true,
      activeConfirmationPassed: options.confirmActive,
      storesRawSecrets: false,
      storesResponseBodies: false,
      notes: [
        'This workflow orchestrates existing RedScope profile, report, and observability stages.',
        'It does not accept arbitrary scanner commands.',
        'Report and memory artifacts store normalized summaries and file references only.',
      ],
    },
    stages,
  }
}

async function runWorkflow(options: Options) {
  validateOptions(options)
  const paths = resolveAndValidatePaths(options)
  await ensureInputFiles(paths)
  if (profileRequiresSourceCache(options.profileId)) {
    await ensureRedScopeSourcesFresh({
      allowPrompt: !options.json,
      json: options.json,
    })
  }

  const profileStage = await runStage<ProfileStageResult>(
    'profile',
    'redscope-profile-runner.ts',
    buildProfileArgs(options, paths),
  )
  const profileSummary: StageSummary = {
    status: 'completed',
    command: profileStage.displayCommand,
    result: summarizeProfileResult(profileStage.parsed),
  }

  if (options.dryRun) {
    const result = {
      dryRun: true,
      profile: options.profileId,
      stages: {
        profile: profileSummary,
        report: {
          status: 'skipped',
          reason: '--dry-run does not write a run directory',
        },
        observe: {
          status: 'skipped',
          reason: '--dry-run does not write a run directory',
        },
      },
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(`Prepared RedScope workflow dry run for ${options.profileId}`)
    console.log('  report: skipped')
    console.log('  observe: skipped')
    return
  }

  const runDir = resolveProjectPath(profileRunDir(profileStage.parsed))
  assertInside(runDir, paths.outputRoot, 'workflow run directory')

  let reportSummary: StageSummary = {
    status: 'skipped',
    reason: '--skip-report was passed',
  }
  if (!options.skipReport) {
    const reportArgs = [
      '--run',
      projectPath(runDir),
      '--output-root',
      projectPath(paths.outputRoot),
      '--json',
    ]
    const reportStage = await runStage<ReportStageResult>(
      'report',
      'redscope-report-pipeline.ts',
      reportArgs,
    )
    reportSummary = {
      status: 'completed',
      command: reportStage.displayCommand,
      result: summarizeReportResult(reportStage.parsed),
    }
  }

  let observeSummary: StageSummary = {
    status: 'skipped',
    reason: '--skip-observe was passed',
  }
  if (!options.skipObserve) {
    const observeArgs = [
      '--run',
      projectPath(runDir),
      '--output-root',
      projectPath(paths.outputRoot),
      '--memory-root',
      projectPath(paths.memoryRoot),
      '--json',
    ]
    const observeStage = await runStage<ObserveStageResult>(
      'observe',
      'redscope-observability.ts',
      observeArgs,
    )
    observeSummary = {
      status: 'completed',
      command: observeStage.displayCommand,
      result: summarizeObserveResult(observeStage.parsed),
    }
  }

  const stages = {
    profile: profileSummary,
    report: reportSummary,
    observe: observeSummary,
  }
  const manifest = workflowManifest(options, paths, runDir, stages)
  const manifestPath = join(runDir, 'workflow-manifest.json')
  await writeJson(manifestPath, manifest)

  const result = {
    dryRun: false,
    profile: options.profileId,
    mode: manifest.mode,
    runDir: projectPath(runDir),
    workflowManifest: projectPath(manifestPath),
    stages,
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Completed RedScope workflow for ${options.profileId}`)
  console.log(`  mode: ${manifest.mode}`)
  console.log(`  run: ${projectPath(runDir)}`)
  console.log(`  report: ${options.skipReport ? 'skipped' : 'completed'}`)
  console.log(`  observe: ${options.skipObserve ? 'skipped' : 'completed'}`)
  console.log(`  workflow manifest: ${projectPath(manifestPath)}`)
}

const options = parseArgs(process.argv.slice(2))

runWorkflow(options).catch(error => {
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
    console.error(`redscope-workflow: ${message}`)
  }
  process.exit(1)
})
