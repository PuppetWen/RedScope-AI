#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
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
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { envNumber, envPathFrom } from './redscope-env-config.ts'

type RiskLevel =
  | 'reference'
  | 'passive'
  | 'baseline'
  | 'active'
  | 'restricted'
  | string

type SourceEntry = {
  id: string
  name: string
  repo: string
  repoSlug?: string
  branch?: string
  riskLevel: RiskLevel
  categories?: string[]
  defaultEnabled?: boolean
  requiredForWorkflow?: boolean
  updateIntervalDays?: number
  redscopeUse?: string
  safetyNotes?: string[]
}

type SourceRegistry = {
  schemaVersion?: number
  generatedAt?: string
  policy?: {
    defaultUpdateIntervalDays?: number
    startupCheck?: boolean
    requireSourcesBeforeWorkflow?: boolean
    promptWhenMissingOrStale?: boolean
    sourceRoot?: string
    cacheRoot?: string
    statePath?: string
    notes?: string[]
  }
  sources?: SourceEntry[]
}

type SourceStateRecord = {
  id: string
  repo: string
  repoSlug: string
  branch: string
  status: 'available' | 'downloaded-only' | 'failed'
  sourceDir?: string
  archivePath?: string
  archiveSha256?: string
  commitSha?: string
  downloadedAt: string
  expiresAt: string
  error?: string
}

type SourceState = {
  schemaVersion: 1
  updatedAt?: string
  sources: Record<string, SourceStateRecord>
}

type SourceItemStatus = 'ok' | 'missing' | 'stale' | 'disabled'

type SourceCheckItem = {
  id: string
  name: string
  repo: string
  riskLevel: RiskLevel
  categories: string[]
  required: boolean
  enabled: boolean
  status: SourceItemStatus
  reason?: string
  lastUpdated?: string
  expiresAt?: string
  sourceDir?: string
  updateIntervalDays: number
}

export type SourceCheckResult = {
  status: 'ok' | 'missing' | 'stale' | 'needs-update'
  canProceed: boolean
  generatedAt: string
  configPath: string
  statePath: string
  sourceRoot: string
  cacheRoot: string
  defaultUpdateIntervalDays: number
  items: SourceCheckItem[]
  missing: string[]
  stale: string[]
  actionableIds: string[]
  updateCommand: string[]
}

type Options = {
  command: 'check' | 'update' | 'list'
  configPath: string
  sourceIds: string[]
  all: boolean
  force: boolean
  yes: boolean
  json: boolean
  strict: boolean
  downloadOnly: boolean
}

type UpdateOptions = {
  configPath?: string
  sourceIds?: string[]
  all?: boolean
  force?: boolean
  downloadOnly?: boolean
}

export type SourceGateOptions = {
  configPath?: string
  allowPrompt?: boolean
  json?: boolean
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultConfigPath = envPathFrom(
  ['REDSCOPE_TOOLS_SOURCE_REGISTRY', 'REDSCOPE_SOURCE_REGISTRY'],
  'tools/redscope-source-registry.json',
)
const defaultSourceRoot = envPathFrom(
  ['REDSCOPE_TOOLS_SOURCE_ROOT', 'REDSCOPE_SOURCE_ROOT'],
  'tools/sources',
)
const defaultCacheRoot = envPathFrom(
  ['REDSCOPE_TOOLS_SOURCE_CACHE_ROOT', 'REDSCOPE_SOURCE_CACHE_ROOT'],
  'tools/cache/sources',
)
const defaultStatePath = envPathFrom(
  ['REDSCOPE_TOOLS_SOURCE_STATE', 'REDSCOPE_SOURCE_STATE'],
  'tools/manifests/redscope-source-state.json',
)
const defaultUpdateIntervalDays = envNumber(
  'REDSCOPE_TOOLS_SOURCE_UPDATE_INTERVAL_DAYS',
  7,
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-source-updater.ts --check [options]
  bun run scripts/redscope-source-updater.ts --update --yes [options]
  bun run scripts/redscope-source-updater.ts --list [options]

Commands:
  --check                 Check required source repositories for freshness
  --update                Download and refresh missing/stale source trees
  --list                  List configured source repositories

Options:
  --config <path>         Source registry path (default: ${defaultConfigPath})
  --source <id>           Limit update to a source id; can be repeated
  --all                   Include optional disabled sources during update/list
  --force                 Refresh even when a source is still fresh
  --yes                   Required for non-interactive update
  --download-only         Download archives and state, skip extraction
  --strict                Exit non-zero when --check finds missing/stale sources
  --json                  Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'check',
    configPath: defaultConfigPath,
    sourceIds: [],
    all: false,
    force: false,
    yes: false,
    json: false,
    strict: false,
    downloadOnly: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--check') {
      options.command = 'check'
      continue
    }
    if (arg === '--update') {
      options.command = 'update'
      continue
    }
    if (arg === '--list') {
      options.command = 'list'
      continue
    }
    if (arg === '--all') {
      options.all = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--yes') {
      options.yes = true
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
    if (arg === '--download-only') {
      options.downloadOnly = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--config':
        options.configPath = next
        break
      case '--source':
        options.sourceIds.push(next)
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
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as T
}

async function writeJsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function loadPaths(registry: SourceRegistry, configPath: string) {
  const sourceRoot = resolveProjectPath(
    registry.policy?.sourceRoot ?? defaultSourceRoot,
  )
  const cacheRoot = resolveProjectPath(
    registry.policy?.cacheRoot ?? defaultCacheRoot,
  )
  const statePath = resolveProjectPath(
    registry.policy?.statePath ?? defaultStatePath,
  )
  const resolvedConfig = resolveProjectPath(configPath)
  assertInside(sourceRoot, repoRoot, 'source root')
  assertInside(cacheRoot, repoRoot, 'cache root')
  assertInside(statePath, repoRoot, 'state path')
  assertInside(resolvedConfig, repoRoot, 'source registry')
  return {
    configPath: resolvedConfig,
    sourceRoot,
    cacheRoot,
    statePath,
  }
}

async function loadRegistry(configPath: string): Promise<SourceRegistry> {
  const resolved = resolveProjectPath(configPath)
  assertInside(resolved, repoRoot, 'source registry')
  const registry = await readJsonFile<SourceRegistry>(resolved)
  if (!Array.isArray(registry.sources)) {
    throw new Error('source registry is missing a sources array')
  }
  return registry
}

async function loadState(statePath: string): Promise<SourceState> {
  if (!(await pathExists(statePath))) {
    return { schemaVersion: 1, sources: {} }
  }
  const state = await readJsonFile<SourceState>(statePath)
  return {
    schemaVersion: 1,
    updatedAt: state.updatedAt,
    sources:
      state.sources && typeof state.sources === 'object' ? state.sources : {},
  }
}

function sourceIntervalDays(
  registry: SourceRegistry,
  source: SourceEntry,
): number {
  return (
    source.updateIntervalDays ??
    registry.policy?.defaultUpdateIntervalDays ??
    defaultUpdateIntervalDays
  )
}

function isEnabled(source: SourceEntry): boolean {
  return source.defaultEnabled !== false
}

function isRequired(source: SourceEntry): boolean {
  return isEnabled(source) && source.requiredForWorkflow !== false
}

function repoSlug(source: SourceEntry): string {
  if (source.repoSlug) return source.repoSlug
  const match = source.repo.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?\/?$/)
  if (!match) {
    throw new Error(`${source.id} must use a GitHub repo or set repoSlug`)
  }
  return match[1]
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function updateCommand(ids: string[] = []): string[] {
  const command = ['bun', 'run', 'redscope:sources', '--', '--update', '--yes']
  for (const id of ids) command.push('--source', id)
  return command
}

async function sourceDirExists(path?: string): Promise<boolean> {
  if (!path) return false
  const resolved = resolveProjectPath(path)
  if (!(await pathExists(resolved))) return false
  const info = await stat(resolved)
  return info.isDirectory()
}

export async function checkRedScopeSources(
  configPath = defaultConfigPath,
): Promise<SourceCheckResult> {
  const registry = await loadRegistry(configPath)
  const paths = loadPaths(registry, configPath)
  const state = await loadState(paths.statePath)
  const now = new Date()
  const defaultDays =
    registry.policy?.defaultUpdateIntervalDays ?? defaultUpdateIntervalDays
  const items: SourceCheckItem[] = []

  for (const source of registry.sources ?? []) {
    const enabled = isEnabled(source)
    const required = isRequired(source)
    const intervalDays = sourceIntervalDays(registry, source)
    const record = state.sources[source.id]
    const expectedDir = join(paths.sourceRoot, source.id)
    const sourceDir = record?.sourceDir
      ? resolveProjectPath(record.sourceDir)
      : expectedDir
    let statusValue: SourceItemStatus = 'ok'
    let reason: string | undefined

    if (!enabled) {
      statusValue = 'disabled'
      reason = 'source is optional and disabled by default'
    } else if (!(await sourceDirExists(sourceDir))) {
      statusValue = 'missing'
      reason = 'source directory is missing'
    } else if (!record?.downloadedAt) {
      statusValue = 'missing'
      reason = 'source state record is missing'
    } else {
      const expiresAt =
        record.expiresAt ??
        addDays(new Date(record.downloadedAt), intervalDays).toISOString()
      const expiresTime = Date.parse(expiresAt)
      if (Number.isFinite(expiresTime) && expiresTime <= now.getTime()) {
        statusValue = 'stale'
        reason = `source is older than ${intervalDays} day(s)`
      }
    }

    items.push({
      id: source.id,
      name: source.name,
      repo: source.repo,
      riskLevel: source.riskLevel,
      categories: source.categories ?? [],
      required,
      enabled,
      status: statusValue,
      reason,
      lastUpdated: record?.downloadedAt,
      expiresAt: record?.expiresAt,
      sourceDir: projectPath(sourceDir),
      updateIntervalDays: intervalDays,
    })
  }

  const requiredItems = items.filter(item => item.required)
  const missing = requiredItems
    .filter(item => item.status === 'missing')
    .map(item => item.id)
  const stale = requiredItems
    .filter(item => item.status === 'stale')
    .map(item => item.id)
  const actionableIds = Array.from(new Set([...missing, ...stale]))
  const statusValue =
    missing.length > 0 && stale.length > 0
      ? 'needs-update'
      : missing.length > 0
        ? 'missing'
        : stale.length > 0
          ? 'stale'
          : 'ok'

  return {
    status: statusValue,
    canProceed: actionableIds.length === 0,
    generatedAt: now.toISOString(),
    configPath: projectPath(paths.configPath),
    statePath: projectPath(paths.statePath),
    sourceRoot: projectPath(paths.sourceRoot),
    cacheRoot: projectPath(paths.cacheRoot),
    defaultUpdateIntervalDays: defaultDays,
    items,
    missing,
    stale,
    actionableIds,
    updateCommand: updateCommand(actionableIds),
  }
}

function renderCheck(result: SourceCheckResult) {
  console.log(`RedScope source status: ${result.status}`)
  console.log(`  config: ${result.configPath}`)
  console.log(`  source root: ${result.sourceRoot}`)
  console.log(`  state: ${result.statePath}`)
  for (const item of result.items) {
    const suffix = item.reason ? ` (${item.reason})` : ''
    const required = item.required ? 'required' : 'optional'
    console.log(`  - ${item.id}: ${item.status}, ${required}${suffix}`)
  }
  if (!result.canProceed) {
    console.log(`  update: ${result.updateCommand.join(' ')}`)
  }
}

export function sourceGateMessage(result: SourceCheckResult): string {
  const details = [
    ...result.missing.map(id => `${id}: missing`),
    ...result.stale.map(id => `${id}: stale`),
  ].join(', ')
  return [
    `RedScope source repositories are required before workflow execution and are not ready (${details}).`,
    `Run ${result.updateCommand.join(' ')} to download/update the required source trees.`,
    'Downloaded PoC material is quarantined reference content; workflows do not execute code from tools/sources directly.',
  ].join(' ')
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    return await new Promise<boolean>(resolveAnswer => {
      rl.question(`${question} [y/N] `, answer => {
        resolveAnswer(/^y(?:es)?$/i.test(answer.trim()))
      })
    })
  } finally {
    rl.close()
  }
}

export async function ensureRedScopeSourcesFresh(
  options: SourceGateOptions = {},
): Promise<SourceCheckResult> {
  const check = await checkRedScopeSources(options.configPath)
  if (check.canProceed) return check

  if (options.allowPrompt && isInteractive()) {
    if (!options.json) renderCheck(check)
    const accepted = await promptYesNo(
      'Required RedScope source repositories are missing or stale. Update now?',
    )
    if (!accepted) {
      throw new Error(
        'Required RedScope source update was declined; workflow execution cannot continue.',
      )
    }
    await updateRedScopeSources({
      configPath: options.configPath,
      sourceIds: check.actionableIds,
      force: true,
    })
    const refreshed = await checkRedScopeSources(options.configPath)
    if (refreshed.canProceed) return refreshed
    throw new Error(sourceGateMessage(refreshed))
  }

  throw new Error(sourceGateMessage(check))
}

async function fetchGitHubCommit(
  source: SourceEntry,
): Promise<string | undefined> {
  const slug = repoSlug(source)
  const branch = source.branch ?? 'main'
  const response = await fetch(
    `https://api.github.com/repos/${slug}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'redscope-source-updater',
      },
    },
  )
  if (!response.ok) return undefined
  const data = (await response.json()) as Record<string, unknown>
  return typeof data.sha === 'string' ? data.sha : undefined
}

async function downloadArchive(
  source: SourceEntry,
  cacheRoot: string,
): Promise<{ archivePath: string; sha256: string; commitSha?: string }> {
  const slug = repoSlug(source)
  const branch = source.branch ?? 'main'
  const commitSha = await fetchGitHubCommit(source)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveName = `${source.id}-${sanitizePathPart(branch)}-${stamp}.tar.gz`
  const archivePath = join(cacheRoot, archiveName)
  assertInside(archivePath, cacheRoot, 'archive path')
  await mkdir(cacheRoot, { recursive: true })

  const response = await fetch(
    `https://github.com/${slug}/archive/refs/heads/${branch}.tar.gz`,
    {
      headers: {
        'User-Agent': 'redscope-source-updater',
      },
    },
  )
  if (!response.ok) {
    throw new Error(
      `${source.id} archive download failed with HTTP ${response.status}`,
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(archivePath, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { archivePath, sha256, commitSha }
}

async function runTarExtract(
  archivePath: string,
  extractRoot: string,
): Promise<void> {
  await mkdir(extractRoot, { recursive: true })
  const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', extractRoot], {
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
    throw new Error(
      stderr.trim() ||
        stdout.trim() ||
        `tar extraction failed with exit code ${exitCode}`,
    )
  }
}

async function replaceSourceDir(
  source: SourceEntry,
  archivePath: string,
  sourceRoot: string,
  cacheRoot: string,
) {
  const extractRoot = join(
    cacheRoot,
    '.extract',
    `${source.id}-${Date.now()}`,
  )
  assertInside(extractRoot, cacheRoot, 'extract root')
  await rm(extractRoot, { recursive: true, force: true })
  try {
    await runTarExtract(archivePath, extractRoot)
    const entries = await readdir(extractRoot, { withFileTypes: true })
    const dirs = entries.filter(entry => entry.isDirectory())
    if (dirs.length !== 1) {
      throw new Error(`${source.id} archive did not extract to one root directory`)
    }
    const extractedDir = join(extractRoot, dirs[0].name)
    const targetDir = join(sourceRoot, source.id)
    assertInside(targetDir, sourceRoot, 'source directory')
    await mkdir(sourceRoot, { recursive: true })
    await rm(targetDir, { recursive: true, force: true })
    await rename(extractedDir, targetDir)
    return targetDir
  } finally {
    await rm(extractRoot, { recursive: true, force: true })
  }
}

function shouldUpdateSource(
  source: SourceEntry,
  check: SourceCheckResult,
  options: UpdateOptions,
): boolean {
  if (options.sourceIds && options.sourceIds.length > 0) {
    return options.sourceIds.includes(source.id)
  }
  if (options.all) return true
  if (options.force) return isEnabled(source)
  return check.actionableIds.includes(source.id)
}

export async function updateRedScopeSources(
  options: UpdateOptions = {},
): Promise<SourceCheckResult> {
  const configPath = options.configPath ?? defaultConfigPath
  const registry = await loadRegistry(configPath)
  const paths = loadPaths(registry, configPath)
  const before = await checkRedScopeSources(configPath)
  const state = await loadState(paths.statePath)
  const now = new Date()

  await mkdir(paths.sourceRoot, { recursive: true })
  await mkdir(paths.cacheRoot, { recursive: true })

  for (const source of registry.sources ?? []) {
    if (!shouldUpdateSource(source, before, options)) continue
    if (!isEnabled(source) && !options.all && !options.sourceIds?.includes(source.id)) {
      continue
    }

    const slug = repoSlug(source)
    const branch = source.branch ?? 'main'
    const intervalDays = sourceIntervalDays(registry, source)
    try {
      const archive = await downloadArchive(source, paths.cacheRoot)
      const sourceDir = options.downloadOnly
        ? undefined
        : await replaceSourceDir(
            source,
            archive.archivePath,
            paths.sourceRoot,
            paths.cacheRoot,
          )
      const downloadedAt = new Date().toISOString()
      const expiresAt = addDays(new Date(downloadedAt), intervalDays).toISOString()
      const record: SourceStateRecord = {
        id: source.id,
        repo: source.repo,
        repoSlug: slug,
        branch,
        status: options.downloadOnly ? 'downloaded-only' : 'available',
        sourceDir: sourceDir ? projectPath(sourceDir) : undefined,
        archivePath: projectPath(archive.archivePath),
        archiveSha256: archive.sha256,
        commitSha: archive.commitSha,
        downloadedAt,
        expiresAt,
      }
      state.sources[source.id] = record
      await writeJsonFile(
        join(dirname(paths.statePath), 'sources', `${source.id}.json`),
        {
          schemaVersion: 1,
          generatedAt: downloadedAt,
          source,
          state: record,
          safety: {
            executionAllowedFromSourceTree: false,
            requiresAuthorizedScope: true,
            notes: source.safetyNotes ?? [],
          },
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.sources[source.id] = {
        id: source.id,
        repo: source.repo,
        repoSlug: slug,
        branch,
        status: 'failed',
        downloadedAt: now.toISOString(),
        expiresAt: now.toISOString(),
        error: message,
      }
      await writeJsonFile(paths.statePath, {
        ...state,
        updatedAt: new Date().toISOString(),
      })
      throw error
    }
  }

  await writeJsonFile(paths.statePath, {
    ...state,
    updatedAt: new Date().toISOString(),
  })
  return checkRedScopeSources(configPath)
}

function renderList(registry: SourceRegistry, all: boolean) {
  const sources = (registry.sources ?? []).filter(
    source => all || isEnabled(source),
  )
  console.log('id\trisk\trequired\tintervalDays\tcategories\trepo')
  for (const source of sources) {
    const interval = sourceIntervalDays(registry, source)
    console.log(
      [
        source.id,
        source.riskLevel,
        isRequired(source) ? 'yes' : 'no',
        String(interval),
        (source.categories ?? []).join(',') || '-',
        source.repo,
      ].join('\t'),
    )
  }
}

async function run(options: Options) {
  if (options.command === 'list') {
    const registry = await loadRegistry(options.configPath)
    if (options.json) console.log(JSON.stringify(registry.sources ?? [], null, 2))
    else renderList(registry, options.all)
    return
  }

  if (options.command === 'check') {
    const result = await checkRedScopeSources(options.configPath)
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else renderCheck(result)
    if (options.strict && !result.canProceed) process.exit(1)
    return
  }

  if (!options.yes && !isInteractive()) {
    throw new Error('--update requires --yes when running non-interactively')
  }

  if (!options.yes) {
    const accepted = await promptYesNo(
      'Download/update RedScope source repositories now?',
    )
    if (!accepted) {
      throw new Error('source update declined')
    }
  }

  const result = await updateRedScopeSources({
    configPath: options.configPath,
    sourceIds: options.sourceIds,
    all: options.all,
    force: options.force,
    downloadOnly: options.downloadOnly,
  })
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else renderCheck(result)
  if (!result.canProceed) process.exit(1)
}

if (import.meta.main) {
  run(parseArgs(process.argv.slice(2))).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`redscope-source-updater: ${message}`)
    process.exit(1)
  })
}
