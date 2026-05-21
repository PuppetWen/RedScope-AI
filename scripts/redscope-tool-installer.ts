#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
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
import { envPathFrom } from './redscope-env-config.ts'

type RiskLevel =
  | 'reference'
  | 'passive'
  | 'baseline'
  | 'active'
  | 'restricted'
  | string

type RegistryTool = {
  id: string
  name: string
  repo: string
  riskLevel: RiskLevel
  category?: string
  defaultEnabled?: boolean
  requires?: string[]
  redscopeUse?: string
}

type ToolRegistry = {
  generatedAt?: string
  policy?: {
    downloadDirectory?: string
    defaultExecution?: string
    requiresScopeForLevels?: string[]
    notes?: string[]
  }
  tools?: RegistryTool[]
}

type GitHubAsset = {
  name: string
  browser_download_url: string
  size?: number
  digest?: string
}

type GitHubRelease = {
  tag_name: string
  html_url?: string
  assets?: GitHubAsset[]
}

type Options = {
  command: 'install' | 'list'
  toolId?: string
  version?: string
  scopePath?: string
  registryPath: string
  platform?: string
  arch?: string
  url?: string
  assetName?: string
  sha256?: string
  dryRun: boolean
  force: boolean
  downloadOnly: boolean
  json: boolean
}

type ScopeFile = {
  owner?: string
  authorization?: {
    authorizedBy?: string
    validFrom?: string
    validTo?: string
    emergencyContact?: string
    reference?: string
  }
  testLevels?: string[]
  targets?: {
    organizations?: string[]
    domains?: string[]
    urls?: string[]
    ips?: string[]
    cidrs?: string[]
    repositories?: string[]
  }
}

type InstallPlan = {
  tool: RegistryTool
  version: string
  releaseTag: string
  platform: string
  arch: string
  assetName: string
  sourceUrl: string
  toolRoot: string
  cachePath: string
  installDir: string
  manifestPath: string
  checksumAssetName?: string
  checksumAssetUrl?: string
  upstreamDigest?: string
  scopePath?: string
  releaseUrl?: string
}

type ChecksumSource =
  | 'user'
  | 'github-digest'
  | 'upstream-checksum'
  | 'computed-only'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultRegistryPath = envPathFrom(
  ['REDSCOPE_TOOLS_TOOL_REGISTRY', 'REDSCOPE_TOOL_REGISTRY'],
  'tools/redscope-tool-registry.json',
)
const defaultToolsRoot = envPathFrom(
  ['REDSCOPE_TOOLS_ROOT', 'REDSCOPE_TOOL_ROOT'],
  'tools',
)
const managedSubdirs = ['bin', 'cache', 'manifests', 'outputs']

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-tool-installer.ts --list
  bun run scripts/redscope-tool-installer.ts --tool <id> --version <tag> --scope <scope.json> [options]

Required for install:
  --tool <id>              Tool id from tools/redscope-tool-registry.json
  --version <tag>          Pinned upstream release tag or version

Safety:
  --scope <scope.json>     Required for baseline, active, and restricted tools
  --dry-run                Resolve and print the install plan without downloading
  --download-only          Download archive and manifest, skip extraction

Source:
  --url <url>              Use an explicit asset URL instead of GitHub release lookup
  --asset-name <name>      Asset filename when --url does not end with one
  --sha256 <hash>          Expected sha256, with or without "sha256:" prefix
  --platform <name>        Override detected platform: windows, linux, darwin
  --arch <name>            Override detected arch: amd64, arm64

Other:
  --registry <path>        Registry path (default: ${defaultRegistryPath})
  --force                  Replace an existing tools/bin/<id>/<version> directory
  --json                   Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'install',
    registryPath: defaultRegistryPath,
    dryRun: false,
    force: false,
    downloadOnly: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === 'install') {
      options.command = 'install'
      continue
    }
    if (arg === 'list' || arg === '--list') {
      options.command = 'list'
      continue
    }
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--download-only') {
      options.downloadOnly = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--tool':
        options.toolId = next
        break
      case '--version':
        options.version = next
        break
      case '--scope':
        options.scopePath = next
        break
      case '--registry':
        options.registryPath = next
        break
      case '--platform':
        options.platform = next
        break
      case '--arch':
        options.arch = next
        break
      case '--url':
        options.url = next
        break
      case '--asset-name':
        options.assetName = next
        break
      case '--sha256':
        options.sha256 = next
        break
      default:
        usage()
    }
    index++
  }

  return options
}

function projectPath(path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
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

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '')
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('sha256 must be a 64-character hex digest')
  }
  return normalized
}

function detectedPlatform(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function detectedArch(): string {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RedScope-Tool-Installer',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  return headers
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}

async function loadRegistry(path: string): Promise<ToolRegistry> {
  const registry = await readJsonFile<ToolRegistry>(path)
  if (!Array.isArray(registry.tools)) {
    throw new Error('registry is missing a tools array')
  }
  return registry
}

function listTools(registry: ToolRegistry, json: boolean) {
  const tools = registry.tools ?? []
  if (json) {
    console.log(JSON.stringify(tools, null, 2))
    return
  }

  console.log('id\tname\trisk\tcategory\tscope-required')
  const scopeLevels = new Set(
    registry.policy?.requiresScopeForLevels ?? ['baseline', 'active', 'restricted'],
  )
  for (const tool of tools) {
    const scopeRequired = scopeLevels.has(tool.riskLevel) ? 'yes' : 'no'
    console.log(
      `${tool.id}\t${tool.name}\t${tool.riskLevel}\t${tool.category ?? '-'}\t${scopeRequired}`,
    )
  }
}

function findTool(registry: ToolRegistry, id: string): RegistryTool {
  const tool = registry.tools?.find(item => item.id === id)
  if (!tool) throw new Error(`unknown tool "${id}". Run with --list first.`)
  if (tool.riskLevel === 'reference') {
    throw new Error(`"${id}" is a reference entry, not an installable tool.`)
  }
  return tool
}

function riskRank(level: string): number {
  switch (level) {
    case 'reference':
      return 0
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

function nonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim())
}

function missingScopeFields(scope: ScopeFile): string[] {
  const missing: string[] = []
  if (!scope.owner) missing.push('owner')
  if (!scope.authorization?.authorizedBy) missing.push('authorization.authorizedBy')
  if (!scope.authorization?.validFrom) missing.push('authorization.validFrom')
  if (!scope.authorization?.validTo) missing.push('authorization.validTo')
  if (!scope.authorization?.emergencyContact) {
    missing.push('authorization.emergencyContact')
  }
  if (!Array.isArray(scope.testLevels) || scope.testLevels.length === 0) {
    missing.push('testLevels')
  }
  if (!scope.targets) missing.push('targets')
  return missing
}

async function validateScopeForTool(
  tool: RegistryTool,
  registry: ToolRegistry,
  scopePath?: string,
): Promise<ScopeFile | undefined> {
  const requiresScope = new Set(
    registry.policy?.requiresScopeForLevels ?? ['baseline', 'active', 'restricted'],
  ).has(tool.riskLevel)

  if (!requiresScope && !scopePath) return undefined
  if (!scopePath) {
    throw new Error(
      `${tool.id} has risk level "${tool.riskLevel}" and requires --scope <scope.json>.`,
    )
  }

  const resolvedScopePath = resolveProjectPath(scopePath)
  assertInside(resolvedScopePath, repoRoot, 'scope path')
  const scope = await readJsonFile<ScopeFile>(resolvedScopePath)
  const missing = missingScopeFields(scope)
  if (missing.length > 0) {
    throw new Error(`scope file is incomplete: ${missing.join(', ')}`)
  }
  if (requiresScope && !scopeAllowsRisk(scope, tool.riskLevel)) {
    throw new Error(
      `scope testLevels do not allow "${tool.riskLevel}" tools. Add an explicit authorized level before installing ${tool.id}.`,
    )
  }

  const requires = new Set(tool.requires ?? [])
  const targets = scope.targets ?? {}
  if (requires.has('repository-scope') && !nonEmptyStringList(targets.repositories)) {
    throw new Error(`${tool.id} requires targets.repositories in the scope file.`)
  }
  if (requires.has('authorized-scope')) {
    const hasTarget =
      nonEmptyStringList(targets.organizations) ||
      nonEmptyStringList(targets.domains) ||
      nonEmptyStringList(targets.urls) ||
      nonEmptyStringList(targets.ips) ||
      nonEmptyStringList(targets.cidrs)
    if (!hasTarget) {
      throw new Error(`${tool.id} requires at least one authorized target in scope.`)
    }
  }

  return scope
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?/)
  if (!match) throw new Error(`unsupported repo URL: ${repoUrl}`)
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') }
}

function releaseTagCandidates(version: string): string[] {
  const trimmed = version.trim()
  const candidates = [trimmed]
  if (trimmed.startsWith('v')) candidates.push(trimmed.slice(1))
  else candidates.push(`v${trimmed}`)
  return [...new Set(candidates)]
}

async function fetchGithubRelease(
  repoUrl: string,
  version: string,
): Promise<GitHubRelease> {
  const { owner, repo } = parseGithubRepo(repoUrl)
  const errors: string[] = []

  for (const tag of releaseTagCandidates(version)) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
    const response = await fetch(url, { headers: githubHeaders() })
    if (response.ok) return (await response.json()) as GitHubRelease
    errors.push(`${tag}: HTTP ${response.status}`)
  }

  throw new Error(
    `could not resolve GitHub release for ${repoUrl} at ${version} (${errors.join('; ')})`,
  )
}

function isChecksumLike(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.includes('checksum') ||
    lower.includes('checksums') ||
    lower.endsWith('.sha256') ||
    lower.endsWith('.sha256sum') ||
    lower.endsWith('.sha256sums') ||
    lower.endsWith('.sha512') ||
    lower.endsWith('.sig') ||
    lower.endsWith('.pem') ||
    lower.includes('sbom') ||
    lower.includes('intoto')
  )
}

function isPackageInstaller(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.deb') ||
    lower.endsWith('.rpm') ||
    lower.endsWith('.apk') ||
    lower.endsWith('.msi') ||
    lower.endsWith('.pkg')
  )
}

function isDownloadableAsset(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.txz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tbz2') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.exe') ||
    lower.endsWith('.jar') ||
    lower.endsWith('.gz')
  )
}

function platformTokens(platform: string): string[] {
  if (platform === 'windows') return ['windows', 'win64', 'win32']
  if (platform === 'darwin') return ['darwin', 'macos', 'osx']
  if (platform === 'linux') return ['linux']
  return [platform]
}

function archTokens(arch: string): string[] {
  if (arch === 'amd64') return ['amd64', 'x86_64', 'x64']
  if (arch === 'arm64') return ['arm64', 'aarch64']
  return [arch]
}

function hasToken(name: string, tokens: string[]): boolean {
  const lower = name.toLowerCase()
  return tokens.some(token => lower.includes(token.toLowerCase()))
}

function assetScore(
  asset: GitHubAsset,
  tool: RegistryTool,
  platform: string,
  arch: string,
): number {
  const lower = asset.name.toLowerCase()
  if (isChecksumLike(asset.name) || isPackageInstaller(asset.name)) return -1
  if (!isDownloadableAsset(asset.name)) return -1

  const universal = hasToken(lower, [
    'all',
    'any',
    'universal',
    'crossplatform',
    'cross-platform',
  ])
  const osMatch = hasToken(lower, platformTokens(platform))
  const archMatch = hasToken(lower, archTokens(arch))

  if (!osMatch && !universal) return -1

  let score = 0
  if (lower.includes(tool.id.toLowerCase())) score += 8
  if (lower.includes(tool.name.toLowerCase())) score += 4
  if (osMatch) score += 20
  if (archMatch) score += 16
  if (universal) score += 6
  if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    score += 3
  }
  if (lower.endsWith('.exe')) score += 2
  return score
}

function selectAsset(
  release: GitHubRelease,
  tool: RegistryTool,
  platform: string,
  arch: string,
): GitHubAsset {
  const assets = release.assets ?? []
  const ranked = assets
    .map(asset => ({ asset, score: assetScore(asset, tool, platform, arch) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)

  const selected = ranked[0]?.asset
  if (!selected) {
    const names = assets.map(asset => asset.name).join(', ')
    throw new Error(
      `no supported ${platform}/${arch} asset found for ${tool.id}. Release assets: ${names}`,
    )
  }
  return selected
}

function findChecksumAsset(
  release: GitHubRelease | undefined,
  selectedAsset: GitHubAsset,
): GitHubAsset | undefined {
  const assets = release?.assets ?? []
  const exact = assets.find(asset => {
    const lower = asset.name.toLowerCase()
    return (
      lower !== selectedAsset.name.toLowerCase() &&
      lower.includes(selectedAsset.name.toLowerCase()) &&
      isChecksumLike(lower)
    )
  })
  if (exact) return exact

  return assets.find(asset => asset.name !== selectedAsset.name && isChecksumLike(asset.name))
}

function assetNameFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname
    const name = basename(pathname)
    return name || fallback
  } catch {
    return fallback
  }
}

async function ensureToolDirs(toolRoot: string) {
  await mkdir(toolRoot, { recursive: true })
  for (const dir of managedSubdirs) {
    await mkdir(join(toolRoot, dir), { recursive: true })
  }
}

function safeVersionPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function buildInstallPlan(
  options: Options,
  registry: ToolRegistry,
): Promise<InstallPlan> {
  if (!options.toolId || !options.version) usage()

  const tool = findTool(registry, options.toolId)
  await validateScopeForTool(tool, registry, options.scopePath)

  const platform = options.platform ?? detectedPlatform()
  const arch = options.arch ?? detectedArch()
  const toolRoot = resolveProjectPath(
    registry.policy?.downloadDirectory ?? defaultToolsRoot,
  )
  assertInside(toolRoot, repoRoot, 'download directory')

  const versionPart = safeVersionPathPart(options.version)
  let release: GitHubRelease | undefined
  let selectedAsset: GitHubAsset

  if (options.url) {
    selectedAsset = {
      name: options.assetName ?? assetNameFromUrl(options.url, `${tool.id}-${versionPart}`),
      browser_download_url: options.url,
    }
  } else {
    release = await fetchGithubRelease(tool.repo, options.version)
    selectedAsset = selectAsset(release, tool, platform, arch)
  }

  const checksumAsset = findChecksumAsset(release, selectedAsset)
  const cacheDir = resolve(toolRoot, 'cache', tool.id, versionPart)
  const installDir = resolve(toolRoot, 'bin', tool.id, versionPart)
  const manifestPath = resolve(
    toolRoot,
    'manifests',
    `${tool.id}-${versionPart}-${platform}-${arch}.json`,
  )
  const cachePath = resolve(cacheDir, selectedAsset.name)

  assertInside(cachePath, toolRoot, 'cache path')
  assertInside(installDir, toolRoot, 'install directory')
  assertInside(manifestPath, toolRoot, 'manifest path')

  return {
    tool,
    version: options.version,
    releaseTag: release?.tag_name ?? options.version,
    releaseUrl: release?.html_url,
    platform,
    arch,
    assetName: selectedAsset.name,
    sourceUrl: selectedAsset.browser_download_url,
    toolRoot,
    cachePath,
    installDir,
    manifestPath,
    checksumAssetName: checksumAsset?.name,
    checksumAssetUrl: checksumAsset?.browser_download_url,
    upstreamDigest: selectedAsset.digest,
    scopePath: options.scopePath ? projectPath(resolveProjectPath(options.scopePath)) : undefined,
  }
}

async function downloadToFile(url: string, path: string) {
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`)
  }
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, response)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const file = Bun.file(path)
  const reader = file.stream().getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    hash.update(chunk.value)
  }
  return hash.digest('hex')
}

function parseChecksumText(text: string, assetName: string): string | undefined {
  const wanted = basename(assetName).toLowerCase()
  const lines = text.split(/\r?\n/)
  const hashes: string[] = []

  for (const line of lines) {
    const match = line.match(/\b([a-fA-F0-9]{64})\b/)
    if (!match) continue
    const hash = match[1].toLowerCase()
    hashes.push(hash)
    if (line.toLowerCase().includes(wanted)) return hash
  }

  return hashes.length === 1 ? hashes[0] : undefined
}

async function resolveExpectedChecksum(
  plan: InstallPlan,
  userSha256?: string,
): Promise<{ expected?: string; source: ChecksumSource; checksumAssetPath?: string }> {
  if (userSha256) {
    return { expected: normalizeSha256(userSha256), source: 'user' }
  }
  if (plan.upstreamDigest?.toLowerCase().startsWith('sha256:')) {
    return {
      expected: normalizeSha256(plan.upstreamDigest),
      source: 'github-digest',
    }
  }
  if (!plan.checksumAssetUrl || !plan.checksumAssetName) {
    return { source: 'computed-only' }
  }

  const checksumPath = resolve(dirname(plan.cachePath), plan.checksumAssetName)
  assertInside(checksumPath, dirname(plan.cachePath), 'checksum path')
  await downloadToFile(plan.checksumAssetUrl, checksumPath)
  const checksumText = await readFile(checksumPath, 'utf8')
  return {
    expected: parseChecksumText(checksumText, plan.assetName),
    source: 'upstream-checksum',
    checksumAssetPath: checksumPath,
  }
}

function isArchive(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.txz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tbz2') ||
    lower.endsWith('.tar')
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function assertInstallDirReady(path: string, force: boolean, toolRoot: string) {
  if (!(await pathExists(path))) return
  const entries = await readdir(path)
  if (entries.length === 0) return
  if (!force) {
    throw new Error(`${projectPath(path)} already exists. Pass --force to replace it.`)
  }

  const toolsBin = resolve(toolRoot, 'bin')
  assertInside(path, toolsBin, 'install directory')
  await rm(path, { recursive: true, force: true })
}

async function extractArchive(archivePath: string, installDir: string) {
  await mkdir(installDir, { recursive: true })
  const proc = Bun.spawn(['tar', '-xf', archivePath, '-C', installDir], {
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
      `tar extraction failed for ${projectPath(archivePath)}:\n${stderr || stdout}`,
    )
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(fullPath)))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function executableScore(path: string, tool: RegistryTool): number {
  const name = basename(path).toLowerCase()
  const stem = name.replace(/\.(exe|bat|cmd|sh)$/i, '')
  const extension = extname(name)
  const executableExtension = ['.exe', '.bat', '.cmd', '.sh', ''].includes(extension)
  if (!executableExtension) return -1
  if (name.includes('license') || name.includes('readme')) return -1

  let score = 0
  if (stem === tool.id.toLowerCase()) score += 20
  if (stem === tool.name.toLowerCase()) score += 12
  if (stem.includes(tool.id.toLowerCase())) score += 8
  if (extension === '.exe') score += 4
  if (extension === '' || extension === '.sh' || extension === '.bat') score += 2
  return score
}

async function findExecutable(
  installDir: string,
  tool: RegistryTool,
): Promise<string | undefined> {
  const files = await walkFiles(installDir)
  const ranked = files
    .map(path => ({ path, score: executableScore(path, tool) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.path
}

async function installDownloadedAsset(
  plan: InstallPlan,
  force: boolean,
  downloadOnly: boolean,
): Promise<{ executablePath?: string; extracted: boolean }> {
  if (downloadOnly) return { extracted: false }

  await assertInstallDirReady(plan.installDir, force, plan.toolRoot)
  await mkdir(plan.installDir, { recursive: true })

  if (isArchive(plan.assetName)) {
    await extractArchive(plan.cachePath, plan.installDir)
  } else {
    const destination = resolve(plan.installDir, basename(plan.assetName))
    assertInside(destination, plan.installDir, 'downloaded executable')
    await copyFile(plan.cachePath, destination)
  }

  const executablePath = await findExecutable(plan.installDir, plan.tool)
  if (executablePath && process.platform !== 'win32') {
    try {
      await chmod(executablePath, 0o755)
    } catch {
      // Some filesystems do not support chmod; the manifest still records the path.
    }
  }
  return { executablePath, extracted: true }
}

async function writeManifest(
  plan: InstallPlan,
  actualSha256: string | undefined,
  checksum: {
    expected?: string
    source: ChecksumSource
    checksumAssetPath?: string
    verified: boolean
  },
  installResult: { executablePath?: string; extracted: boolean },
  options: Options,
) {
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: {
      id: plan.tool.id,
      name: plan.tool.name,
      repo: plan.tool.repo,
      riskLevel: plan.tool.riskLevel,
      category: plan.tool.category,
      requires: plan.tool.requires ?? [],
      defaultEnabled: false,
    },
    install: {
      version: plan.version,
      releaseTag: plan.releaseTag,
      platform: plan.platform,
      arch: plan.arch,
      sourceUrl: plan.sourceUrl,
      releaseUrl: plan.releaseUrl,
      assetName: plan.assetName,
      cachePath: projectPath(plan.cachePath),
      installDir: projectPath(plan.installDir),
      executablePath: installResult.executablePath
        ? projectPath(installResult.executablePath)
        : null,
      extracted: installResult.extracted,
      downloadOnly: options.downloadOnly,
    },
    checksum: {
      sha256: actualSha256,
      expectedSha256: checksum.expected ?? null,
      source: checksum.source,
      verified: checksum.verified,
      checksumAssetPath: checksum.checksumAssetPath
        ? projectPath(checksum.checksumAssetPath)
        : null,
      checksumAssetName: plan.checksumAssetName ?? null,
    },
    authorization: {
      scopePath: plan.scopePath ?? null,
      scopeRequired: ['baseline', 'active', 'restricted'].includes(
        plan.tool.riskLevel,
      ),
      executionDisabledByDefault: true,
      runProfilesEnabled: false,
    },
    policy: {
      globalInstall: false,
      installRoot: 'tools',
      notes: [
        'This manifest records a project-local download only.',
        'The installer does not run scanners or modify the system PATH.',
        'Execution profiles must validate scope again before running tools.',
      ],
    },
  }

  await mkdir(dirname(plan.manifestPath), { recursive: true })
  await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function runInstall(options: Options) {
  const registryPath = resolveProjectPath(options.registryPath)
  const registry = await loadRegistry(registryPath)

  if (options.command === 'list') {
    listTools(registry, options.json)
    return
  }

  const plan = await buildInstallPlan(options, registry)
  if (options.dryRun) {
    const output = {
      dryRun: true,
      plan: {
        tool: plan.tool.id,
        riskLevel: plan.tool.riskLevel,
        version: plan.version,
        releaseTag: plan.releaseTag,
        platform: plan.platform,
        arch: plan.arch,
        assetName: plan.assetName,
        sourceUrl: plan.sourceUrl,
        cachePath: projectPath(plan.cachePath),
        installDir: projectPath(plan.installDir),
        manifestPath: projectPath(plan.manifestPath),
        scopePath: plan.scopePath ?? null,
        checksumAssetName: plan.checksumAssetName ?? null,
      },
    }
    console.log(options.json ? JSON.stringify(output, null, 2) : JSON.stringify(output, null, 2))
    return
  }

  await ensureToolDirs(plan.toolRoot)
  await downloadToFile(plan.sourceUrl, plan.cachePath)
  const actualSha256 = await sha256File(plan.cachePath)
  const expected = await resolveExpectedChecksum(plan, options.sha256)
  const verified = expected.expected ? expected.expected === actualSha256 : false
  if (expected.expected && !verified) {
    throw new Error(
      `checksum mismatch for ${plan.assetName}: expected ${expected.expected}, got ${actualSha256}`,
    )
  }

  const installResult = await installDownloadedAsset(
    plan,
    options.force,
    options.downloadOnly,
  )
  const manifest = await writeManifest(
    plan,
    actualSha256,
    {
      expected: expected.expected,
      source: expected.expected ? expected.source : 'computed-only',
      checksumAssetPath: expected.checksumAssetPath,
      verified,
    },
    installResult,
    options,
  )

  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2))
    return
  }

  console.log(`Installed ${plan.tool.id} ${plan.releaseTag}`)
  console.log(`  cache: ${projectPath(plan.cachePath)}`)
  console.log(`  install: ${projectPath(plan.installDir)}`)
  console.log(`  manifest: ${projectPath(plan.manifestPath)}`)
  console.log(
    `  checksum: ${actualSha256} (${verified ? 'verified' : 'recorded only'})`,
  )
  if (installResult.executablePath) {
    console.log(`  executable: ${projectPath(installResult.executablePath)}`)
  }
}

runInstall(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-tool-installer: ${error.message}`)
  process.exit(1)
})
