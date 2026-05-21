#!/usr/bin/env bun
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { ensureRedScopeSourcesFresh } from './redscope-source-updater.ts'
import { envPathFrom } from './redscope-env-config.ts'

type Status =
  | 'completed'
  | 'needs-scope'
  | 'needs-target'
  | 'needs-profile'
  | 'unsupported-target'

type Options = {
  target?: string
  profileId?: string
  scopePath?: string
  repository?: string
  artifact?: string
  profilesPath?: string
  outputRoot?: string
  memoryRoot?: string
  semgrepConfig?: string
  execute: boolean
  confirmActive: boolean
  dryRun: boolean
  json: boolean
  skipReport: boolean
  skipObserve: boolean
}

type AdapterResult = {
  status: Status
  generatedAt: string
  target?: string
  profile?: string
  reason?: string
  missing?: string[]
  suggestedCommand?: string[]
  workflow?: unknown
}

function profileRequiresSourceCache(profileId: string): boolean {
  return (
    profileId !== 'repo-secret-and-sast' &&
    profileId !== 'authorized-gitleaks-secret-scan' &&
    profileId !== 'authorized-semgrep-sast' &&
    profileId !== 'authorized-low-impact-validator' &&
    profileId !== 'authorized-business-logic-validation' &&
    profileId !== 'authorized-stateful-business-logic-validation'
  )
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-command-adapter.ts <url|domain|company> --scope <scope.json> [options]
  bun run scripts/redscope-command-adapter.ts --repository <path> --scope <scope.json> [options]
  bun run scripts/redscope-command-adapter.ts --artifact <path> --scope <scope.json> [options]

Profile inference:
  URL                 baseline-url-review
  domain/company      passive-company-recon
  --repository path   repo-secret-and-sast
  artifact/log path   threat-trace-artifact-review
  --gitleaks-scan     authorized-gitleaks-secret-scan
  --semgrep-sast      authorized-semgrep-sast
  --http-probe        authorized-http-probe
  --nuclei-low        authorized-nuclei-low
  --scanner-baseline  authorized-third-party-scanner-baseline
  --poc-validate      authorized-poc-candidate-validation
  --low-impact-validate authorized-low-impact-validator
  --logic-validate    authorized-business-logic-validation
  --stateful-logic-validate authorized-stateful-business-logic-validation

Options:
  --profile <id>        Override inferred profile
  --scope <path>        Scope file required before workflow execution
  --execute             Pass through to redscope:workflow
  --confirm-active      Pass through to redscope:workflow
  --dry-run             Validate and print the plan without writing files
  --output-root <path>  Override workflow output root
  --memory-root <path>  Override workflow memory root
  --skip-report         Pass through to redscope:workflow
  --skip-observe        Pass through to redscope:workflow
  --json                Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    execute: false,
    confirmActive: false,
    dryRun: false,
    json: false,
    skipReport: false,
    skipObserve: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--execute') {
      options.execute = true
      continue
    }
    if (arg === '--confirm-active') {
      options.confirmActive = true
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
    if (arg === '--skip-report') {
      options.skipReport = true
      continue
    }
    if (arg === '--skip-observe') {
      options.skipObserve = true
      continue
    }
    if (arg === '--http-probe') {
      options.profileId = 'authorized-http-probe'
      continue
    }
    if (arg === '--gitleaks-scan') {
      options.profileId = 'authorized-gitleaks-secret-scan'
      continue
    }
    if (arg === '--semgrep-sast') {
      options.profileId = 'authorized-semgrep-sast'
      continue
    }
    if (arg === '--nuclei-low') {
      options.profileId = 'authorized-nuclei-low'
      continue
    }
    if (arg === '--scanner-baseline') {
      options.profileId = 'authorized-third-party-scanner-baseline'
      continue
    }
    if (arg === '--poc-validate') {
      options.profileId = 'authorized-poc-candidate-validation'
      continue
    }
    if (arg === '--low-impact-validate') {
      options.profileId = 'authorized-low-impact-validator'
      continue
    }
    if (arg === '--logic-validate') {
      options.profileId = 'authorized-business-logic-validation'
      continue
    }
    if (arg === '--stateful-logic-validate') {
      options.profileId = 'authorized-stateful-business-logic-validation'
      continue
    }

    const next = argv[index + 1]
    if (arg.startsWith('--')) {
      if (!next || next.startsWith('--')) usage()
      switch (arg) {
        case '--profile':
          options.profileId = next
          break
        case '--scope':
          options.scopePath = next
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
      continue
    }

    if (!options.target) {
      options.target = arg
      continue
    }

    options.target = `${options.target} ${arg}`
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

function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isIp(value: string): boolean {
  return net.isIP(value.trim()) !== 0
}

function looksLikeArtifactPath(value: string): boolean {
  return (
    /[\\/]/.test(value) ||
    /\.(log|json|jsonl|csv|txt|pcap|evtx|zip|tar|gz)$/i.test(value)
  )
}

function inferProfile(options: Options): {
  profile?: string
  status?: Status
  reason?: string
} {
  if (options.profileId) return { profile: options.profileId }
  if (options.repository) return { profile: 'repo-secret-and-sast' }
  if (options.artifact) return { profile: 'threat-trace-artifact-review' }
  const target = options.target?.trim()
  if (!target) return { status: 'needs-target', reason: 'No target was supplied.' }
  if (isUrl(target)) return { profile: 'baseline-url-review' }
  if (isIp(target)) {
    return {
      status: 'unsupported-target',
      reason:
        'No deterministic RedScope profile currently accepts raw IP targets; add a URL/domain profile or extend the profile registry first.',
    }
  }
  if (looksLikeArtifactPath(target)) {
    return { profile: 'threat-trace-artifact-review' }
  }
  return { profile: 'passive-company-recon' }
}

function profileUsesRepositoryTarget(profile: string): boolean {
  return [
    'repo-secret-and-sast',
    'authorized-gitleaks-secret-scan',
    'authorized-semgrep-sast',
  ].includes(profile)
}

function targetArgs(options: Options, profile: string): string[] {
  if (profileUsesRepositoryTarget(profile)) {
    const repository = options.repository ?? options.target
    if (!repository) {
      return []
    }
    return ['--repository', repository]
  }
  if (profile === 'threat-trace-artifact-review') {
    const artifact = options.artifact ?? options.target
    if (!artifact) {
      return []
    }
    return ['--artifact', artifact]
  }
  return options.target ? ['--target', options.target] : []
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function buildSuggestedCommand(
  options: Options,
  profile: string,
  scopePath =
    options.scopePath ??
    envPathFrom(
      ['REDSCOPE_TOOLS_DEFAULT_SCOPE', 'REDSCOPE_DEFAULT_SCOPE'],
      'tools/scope.json',
    ),
): string[] {
  const args = [
    'bun',
    'run',
    'redscope:command',
    '--',
    ...(options.repository || options.artifact ? [] : options.target ? [options.target] : []),
    '--profile',
    profile,
    '--scope',
    scopePath,
  ]
  if (options.repository) args.push('--repository', options.repository)
  if (options.artifact) args.push('--artifact', options.artifact)
  if (options.execute) args.push('--execute')
  if (options.confirmActive) args.push('--confirm-active')
  return args
}

function workflowArgs(options: Options, profile: string): string[] {
  if (!options.scopePath) throw new Error('scope path is required')
  const args = [
    '--profile',
    profile,
    '--scope',
    options.scopePath,
    '--json',
    ...targetArgs(options, profile),
  ]
  if (options.profilesPath) args.push('--profiles', options.profilesPath)
  if (options.outputRoot) args.push('--output-root', options.outputRoot)
  if (options.memoryRoot) args.push('--memory-root', options.memoryRoot)
  if (options.semgrepConfig) args.push('--semgrep-config', options.semgrepConfig)
  if (options.execute) args.push('--execute')
  if (options.confirmActive) args.push('--confirm-active')
  if (options.dryRun) args.push('--dry-run')
  if (options.skipReport) args.push('--skip-report')
  if (options.skipObserve) args.push('--skip-observe')
  return args
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const source = start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed
  return JSON.parse(source) as unknown
}

async function runWorkflow(options: Options, profile: string): Promise<unknown> {
  const scriptPath = join(scriptDir, 'redscope-workflow.ts')
  const args = workflowArgs(options, profile)
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
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `workflow exited ${exitCode}`)
  }
  return parseJsonOutput(stdout)
}

async function validateInputPaths(options: Options) {
  for (const [label, rawPath] of [
    ['scope path', options.scopePath],
    ['profile registry path', options.profilesPath],
    ['output root', options.outputRoot],
    ['memory root', options.memoryRoot],
    ['repository target', options.repository],
    ['artifact target', options.artifact],
    ['semgrep config', options.semgrepConfig],
  ] as const) {
    if (!rawPath) continue
    const resolved = resolveProjectPath(rawPath)
    assertInside(resolved, repoRoot, label)
  }
  if (options.scopePath) {
    const scopePath = resolveProjectPath(options.scopePath)
    if (!(await pathExists(scopePath))) {
      throw new Error(`${projectPath(scopePath)} does not exist`)
    }
  }
  if (options.target && looksLikeArtifactPath(options.target) && !isUrl(options.target)) {
    const artifactPath = resolveProjectPath(options.target)
    assertInside(artifactPath, repoRoot, 'artifact target')
  }
}

function renderText(result: AdapterResult) {
  if (result.status === 'completed') {
    console.log(`RedScope workflow completed for ${result.profile}`)
    if (result.target) console.log(`  target: ${result.target}`)
    console.log('  source: redscope:workflow')
    return
  }

  console.log(`RedScope command status: ${result.status}`)
  if (result.reason) console.log(`  reason: ${result.reason}`)
  if (result.missing && result.missing.length > 0) {
    console.log(`  missing: ${result.missing.join(', ')}`)
  }
  if (result.suggestedCommand) {
    console.log(
      `  suggested: ${result.suggestedCommand.map(shellQuoteForDisplay).join(' ')}`,
    )
  }
}

async function runAdapter(options: Options) {
  await validateInputPaths(options)
  const inferred = inferProfile(options)
  const target = options.repository ?? options.artifact ?? options.target
  const now = new Date().toISOString()

  if (!inferred.profile) {
    const result: AdapterResult = {
      status: inferred.status ?? 'needs-profile',
      generatedAt: now,
      target,
      reason: inferred.reason,
    }
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else renderText(result)
    return
  }

  const profile = inferred.profile
  if (!targetArgs(options, profile).length) {
    const result: AdapterResult = {
      status: 'needs-target',
      generatedAt: now,
      profile,
      reason: 'The selected profile needs a target or repository.',
      missing:
        profileUsesRepositoryTarget(profile)
          ? ['--repository']
          : profile === 'threat-trace-artifact-review'
            ? ['--artifact']
            : ['target'],
    }
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else renderText(result)
    return
  }

  if (!options.scopePath) {
    const result: AdapterResult = {
      status: 'needs-scope',
      generatedAt: now,
      target,
      profile,
      reason:
        'A scope file is required before RedScope can create workflow artifacts.',
      missing: ['--scope'],
      suggestedCommand: buildSuggestedCommand(options, profile),
    }
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else renderText(result)
    return
  }

  if (profileRequiresSourceCache(profile)) {
    await ensureRedScopeSourcesFresh({
      allowPrompt: !options.json,
      json: options.json,
    })
  }
  const workflow = await runWorkflow(options, profile)
  const result: AdapterResult = {
    status: 'completed',
    generatedAt: now,
    target,
    profile,
    workflow,
  }

  if (options.json) console.log(JSON.stringify(result, null, 2))
  else renderText(result)
}

const options = parseArgs(process.argv.slice(2))

runAdapter(options).catch(error => {
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
    console.error(`redscope-command-adapter: ${message}`)
  }
  process.exit(1)
})
