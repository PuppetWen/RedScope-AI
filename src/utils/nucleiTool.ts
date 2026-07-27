/**
 * Nuclei workspace helper.
 *
 * When a test step needs template-based verification:
 *   1. Look for a local nuclei binary (PATH, tools/bin/nuclei, …)
 *   2. If missing, return a user-facing prompt to download it into the
 *      current project (`tools/bin/nuclei`)
 *   3. After install (or if already present), run a bounded scan and map
 *      JSONL hits into evidence-gated ProbeObservations
 *
 * This does NOT embed exploit payloads. Nuclei is an external ProjectDiscovery
 * binary; templates come from the operator's template pack / nuclei-templates.
 */

import { existsSync, mkdirSync, readdirSync, statSync, chmodSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { join, dirname, delimiter, resolve } from 'path'
import { homedir, platform, arch, tmpdir } from 'os'
import { getCwd } from './cwd.js'
import {
  observationFromScannerHit,
  type ProbeObservation,
} from './pocVerification.js'
import { reportHostProgress } from './engagementProgress.js'

export const NUCLEI_TOOL_ID = 'nuclei'

export type NucleiPresence = {
  available: boolean
  binaryPath?: string
  version?: string
  source: 'path' | 'tools-bin' | 'workspace' | 'missing'
}

export type NucleiPrompt = {
  needed: boolean
  message: string
  installCommand: string
  installDir: string
}

export type NucleiRunOptions = {
  targets: string[]
  /** Directory or file of templates; optional — nuclei default templates if omitted. */
  templates?: string
  severity?: string
  rateLimit?: number
  concurrency?: number
  timeoutSeconds?: number
  /** Extra CLI args (appended). */
  extraArgs?: string[]
  /** Host id for progress auto-write. */
  hostId?: string
  /** Working directory for outputs. */
  outputDir?: string
  /** Soft wall-clock cap ms (default 120s). */
  maxRuntimeMs?: number
  binaryPath?: string
}

export type NucleiHit = {
  templateId?: string
  name?: string
  severity?: string
  host?: string
  matchedAt?: string
  evidence?: string
  type?: string
  raw: Record<string, unknown>
}

export type NucleiRunResult = {
  ok: boolean
  binaryPath: string
  hits: NucleiHit[]
  observations: ProbeObservation[]
  stdoutTail: string
  stderrTail: string
  exitCode: number | null
  timedOut: boolean
  prompt?: NucleiPrompt
}

function toolsBinDir(cwd = getCwd()): string {
  return join(cwd, 'tools', 'bin')
}

function nucleiBinaryName(): string {
  return platform() === 'win32' ? 'nuclei.exe' : 'nuclei'
}

function candidateBinaryPaths(cwd = getCwd()): string[] {
  const name = nucleiBinaryName()
  const out: string[] = []
  // workspace tools/bin (preferred — "current folder")
  out.push(join(toolsBinDir(cwd), name))
  out.push(join(toolsBinDir(cwd), 'nuclei', name))
  // versioned installer layout: tools/bin/nuclei/<ver>/...
  const versionedRoot = join(toolsBinDir(cwd), 'nuclei')
  if (existsSync(versionedRoot)) {
    try {
      for (const entry of readdirSync(versionedRoot)) {
        const p = join(versionedRoot, entry, name)
        if (existsSync(p)) out.push(p)
        // sometimes nested one more level
        const nested = join(versionedRoot, entry)
        if (existsSync(nested) && statSync(nested).isDirectory()) {
          try {
            for (const sub of readdirSync(nested)) {
              const sp = join(nested, sub, name)
              if (existsSync(sp)) out.push(sp)
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  // PATH
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    out.push(join(dir, name))
  }
  // common user go bin
  out.push(join(homedir(), 'go', 'bin', name))
  return out
}

function probeVersion(binaryPath: string): string | undefined {
  try {
    const r = spawnSync(binaryPath, ['-version'], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    })
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const m = text.match(/Nuclei Engine Version:\s*([vV]?[\d.]+)/i) ??
      text.match(/\bv?(\d+\.\d+\.\d+)\b/)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** Locate nuclei on PATH or under tools/bin in the current workspace. */
export function detectNuclei(cwd = getCwd()): NucleiPresence {
  for (const candidate of candidateBinaryPaths(cwd)) {
    if (!existsSync(candidate)) continue
    try {
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    const version = probeVersion(candidate)
    const source: NucleiPresence['source'] = candidate.includes(
      `${join('tools', 'bin')}`,
    )
      ? candidate.includes(`${join('tools', 'bin', 'nuclei', '')}`) ||
        /tools[\\/]+bin[\\/]+nuclei[\\/]/.test(candidate)
        ? 'tools-bin'
        : 'workspace'
      : 'path'
    return {
      available: true,
      binaryPath: candidate,
      version,
      source: source === 'workspace' && candidate.startsWith(toolsBinDir(cwd))
        ? 'workspace'
        : source,
    }
  }
  return { available: false, source: 'missing' }
}

export function getNucleiInstallDir(cwd = getCwd()): string {
  return toolsBinDir(cwd)
}

/** User-facing prompt when nuclei is required but missing. */
export function buildNucleiMissingPrompt(cwd = getCwd()): NucleiPrompt {
  const installDir = getNucleiInstallDir(cwd)
  return {
    needed: true,
    installDir,
    installCommand: 'bun run redscope:nuclei-setup',
    message: [
      'Nuclei is required for template-based verification on this step, but was not found.',
      '',
      'Download it into the current project folder:',
      `  ${installDir}${platform() === 'win32' ? '\\' : '/'}nuclei${platform() === 'win32' ? '.exe' : ''}`,
      '',
      'Run one of:',
      '  bun run redscope:nuclei-setup',
      '  bun run redscope:tool -- --tool nuclei --version latest --force --download-only',
      '',
      'After install, RedScope will call nuclei automatically for authorized targets.',
      'Nuclei is third-party (ProjectDiscovery). Only scan hosts inside your written scope.',
    ].join('\n'),
  }
}

export function formatNucleiStatus(presence: NucleiPresence): string {
  if (!presence.available) {
    return 'Nuclei: missing — run `bun run redscope:nuclei-setup` to install into tools/bin'
  }
  return `Nuclei: ${presence.version ?? 'ok'} · ${presence.source} · ${presence.binaryPath}`
}

/**
 * Ensure nuclei exists. If missing and `autoInstall` is true, download into
 * tools/bin. Returns presence + optional prompt (when still missing).
 */
export async function ensureNuclei(options?: {
  cwd?: string
  autoInstall?: boolean
  /** Called before network install so UIs can show the prompt. */
  onPrompt?: (prompt: NucleiPrompt) => void
}): Promise<{ presence: NucleiPresence; prompt?: NucleiPrompt; installed: boolean }> {
  const cwd = options?.cwd ?? getCwd()
  const existing = detectNuclei(cwd)
  if (existing.available) {
    return { presence: existing, installed: false }
  }
  const prompt = buildNucleiMissingPrompt(cwd)
  options?.onPrompt?.(prompt)
  if (!options?.autoInstall) {
    return { presence: existing, prompt, installed: false }
  }
  const installedPath = await downloadNucleiToWorkspace(cwd)
  if (!installedPath) {
    return { presence: detectNuclei(cwd), prompt, installed: false }
  }
  return {
    presence: detectNuclei(cwd),
    installed: true,
  }
}

function githubArch(): { goos: string; goarch: string } {
  const goos =
    platform() === 'win32'
      ? 'windows'
      : platform() === 'darwin'
        ? 'macOS'
        : 'linux'
  const goarch =
    arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'amd64' : arch()
  return { goos, goarch }
}

/**
 * Download the latest nuclei release asset into tools/bin of the workspace.
 * Best-effort; returns binary path or null.
 */
export async function downloadNucleiToWorkspace(
  cwd = getCwd(),
): Promise<string | null> {
  const { goos, goarch } = githubArch()
  const api =
    'https://api.github.com/repos/projectdiscovery/nuclei/releases/latest'
  let release: {
    tag_name?: string
    assets?: Array<{ name: string; browser_download_url: string }>
  }
  try {
    const res = await fetch(api, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RedScopeAI-NucleiSetup/1.0',
      },
    })
    if (!res.ok) return null
    release = (await res.json()) as typeof release
  } catch {
    return null
  }
  const assets = release.assets ?? []
  const want = (name: string) => {
    const n = name.toLowerCase()
    const osTok = goos.toLowerCase()
    const archTok = goarch.toLowerCase()
    return (
      n.includes(osTok) &&
      n.includes(archTok) &&
      (n.endsWith('.zip') || n.endsWith('.tar.gz'))
    )
  }
  const asset = assets.find(a => want(a.name))
  if (!asset) return null

  const binDir = toolsBinDir(cwd)
  mkdirSync(binDir, { recursive: true })
  const archivePath = join(
    tmpdir(),
    `redscope-nuclei-${release.tag_name ?? 'latest'}-${asset.name}`,
  )
  try {
    const bin = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'RedScopeAI-NucleiSetup/1.0' },
      redirect: 'follow',
    })
    if (!bin.ok) return null
    const buf = Buffer.from(await bin.arrayBuffer())
    await Bun.write(archivePath, buf)
  } catch {
    return null
  }

  const extractDir = join(tmpdir(), `redscope-nuclei-extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })
  try {
    if (asset.name.endsWith('.zip')) {
      if (platform() === 'win32') {
        spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
          ],
          { stdio: 'ignore', windowsHide: true },
        )
      } else {
        spawnSync('unzip', ['-o', archivePath, '-d', extractDir], {
          stdio: 'ignore',
        })
      }
    } else {
      spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        stdio: 'ignore',
      })
    }
  } catch {
    return null
  }

  const name = nucleiBinaryName()
  const found = findFileRecursive(extractDir, name)
  if (!found) return null
  const dest = join(binDir, name)
  try {
    const { copyFileSync } = await import('fs')
    copyFileSync(found, dest)
    if (platform() !== 'win32') chmodSync(dest, 0o755)
  } catch {
    return null
  }
  return dest
}

function findFileRecursive(root: string, name: string): string | null {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(full)
      else if (entry === name || entry.toLowerCase() === name.toLowerCase()) {
        return full
      }
    }
  }
  return null
}

function parseNucleiJsonl(text: string): NucleiHit[] {
  const hits: NucleiHit[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const info = (obj.info ?? {}) as Record<string, unknown>
      const evidenceParts = [
        typeof obj['matched-at'] === 'string' ? obj['matched-at'] : undefined,
        typeof obj['matcher-name'] === 'string'
          ? `matcher=${obj['matcher-name']}`
          : undefined,
        typeof obj.curl_command === 'string' ? 'curl_replay_present' : undefined,
        Array.isArray(obj['extracted-results'])
          ? `extracted=${(obj['extracted-results'] as unknown[]).slice(0, 3).join(',')}`
          : undefined,
      ].filter(Boolean)
      hits.push({
        templateId:
          typeof obj['template-id'] === 'string'
            ? obj['template-id']
            : typeof obj.templateID === 'string'
              ? obj.templateID
              : undefined,
        name: typeof info.name === 'string' ? info.name : undefined,
        severity:
          typeof info.severity === 'string'
            ? info.severity
            : typeof obj.severity === 'string'
              ? obj.severity
              : undefined,
        host: typeof obj.host === 'string' ? obj.host : undefined,
        matchedAt:
          typeof obj['matched-at'] === 'string'
            ? obj['matched-at']
            : undefined,
        evidence: evidenceParts.join(' | ') || undefined,
        type: typeof obj.type === 'string' ? obj.type : undefined,
        raw: obj,
      })
    } catch {
      /* skip bad line */
    }
  }
  return hits
}

export function hitsToObservations(hits: NucleiHit[]): ProbeObservation[] {
  return hits.map(hit =>
    observationFromScannerHit({
      templateId: hit.templateId,
      matched: true,
      evidence: [
        hit.name,
        hit.severity ? `severity=${hit.severity}` : null,
        hit.matchedAt,
        hit.evidence,
        // Strong-ish marker when extractor returned something concrete
        hit.evidence?.includes('extracted=')
          ? 'scanner extracted proof values'
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      request: hit.host,
      response: hit.matchedAt,
      confidence: hit.severity === 'info' || hit.severity === 'unknown' ? 0.55 : 0.82,
    }),
  )
}

/**
 * Run nuclei against targets. If binary missing, returns prompt and ok=false
 * without throwing — callers should surface the prompt to the user.
 */
export async function runNuclei(
  options: NucleiRunOptions,
): Promise<NucleiRunResult> {
  const ensured = await ensureNuclei({
    autoInstall: false,
  })
  const binary =
    options.binaryPath ??
    ensured.presence.binaryPath ??
    (ensured.presence.available ? ensured.presence.binaryPath : undefined)

  if (!binary) {
    return {
      ok: false,
      binaryPath: '',
      hits: [],
      observations: [],
      stdoutTail: '',
      stderrTail: '',
      exitCode: null,
      timedOut: false,
      prompt: ensured.prompt ?? buildNucleiMissingPrompt(),
    }
  }

  if (options.hostId) {
    reportHostProgress({
      hostId: options.hostId,
      progress: 50,
      activity: `nuclei ${ensured.presence.version ?? ''} · ${options.targets.length} target(s)`,
      status: 'testing',
    })
  }

  const outDir =
    options.outputDir ?? join(getCwd(), 'tools', 'outputs', 'nuclei-auto')
  mkdirSync(outDir, { recursive: true })
  const jsonlPath = join(outDir, `nuclei-${Date.now()}.jsonl`)

  const args = [
    '-jsonl',
    '-silent',
    '-no-color',
    '-rate-limit',
    String(options.rateLimit ?? 30),
    '-c',
    String(options.concurrency ?? 10),
    '-timeout',
    String(options.timeoutSeconds ?? 8),
    '-o',
    jsonlPath,
  ]
  if (options.severity) {
    args.push('-severity', options.severity)
  } else {
    // Default to low false-positive surface unless caller widens it.
    args.push('-severity', 'low,medium,high,critical')
  }
  if (options.templates) {
    args.push('-t', options.templates)
  }
  for (const t of options.targets) {
    args.push('-u', t)
  }
  if (options.extraArgs) args.push(...options.extraArgs)

  const maxRuntimeMs = options.maxRuntimeMs ?? 120_000
  const result = await spawnCapturing(binary, args, maxRuntimeMs)

  let hits: NucleiHit[] = []
  try {
    if (existsSync(jsonlPath)) {
      const { readFileSync } = await import('fs')
      hits = parseNucleiJsonl(readFileSync(jsonlPath, 'utf-8'))
    }
  } catch {
    // fall back to stdout parse
    hits = parseNucleiJsonl(result.stdout)
  }
  if (hits.length === 0 && result.stdout) {
    hits = parseNucleiJsonl(result.stdout)
  }

  const observations = hitsToObservations(hits)

  if (options.hostId) {
    reportHostProgress({
      hostId: options.hostId,
      progress: 70,
      activity: `nuclei done · ${hits.length} hit(s)`,
      status: 'testing',
    })
  }

  return {
    ok: result.exitCode === 0 || hits.length > 0,
    binaryPath: binary,
    hits,
    observations,
    stdoutTail: result.stdout.slice(-2000),
    stderrTail: result.stderr.slice(-2000),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  }
}

function spawnCapturing(
  binary: string,
  args: string[],
  maxRuntimeMs: number,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}> {
  return new Promise(resolvePromise => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, maxRuntimeMs)
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8')
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000)
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8')
      if (stderr.length > 500_000) stderr = stderr.slice(-250_000)
    })
    child.on('error', err => {
      clearTimeout(timer)
      resolvePromise({
        stdout,
        stderr: `${stderr}\n${err.message}`,
        exitCode: 1,
        timedOut,
      })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
      })
    })
  })
}

/**
 * Convenience: ensure nuclei (prompt if missing), run, and return
 * observations ready for verifyAndRecordFinding.
 */
export async function runNucleiForHost(params: {
  hostId: string
  targets: string[]
  autoInstall?: boolean
  severity?: string
  templates?: string
  onPrompt?: (prompt: NucleiPrompt) => void
}): Promise<NucleiRunResult> {
  if (params.autoInstall) {
    const ensured = await ensureNuclei({
      autoInstall: true,
      onPrompt: params.onPrompt,
    })
    if (!ensured.presence.available) {
      return {
        ok: false,
        binaryPath: '',
        hits: [],
        observations: [],
        stdoutTail: '',
        stderrTail: '',
        exitCode: null,
        timedOut: false,
        prompt: ensured.prompt ?? buildNucleiMissingPrompt(),
      }
    }
  }
  return runNuclei({
    targets: params.targets,
    hostId: params.hostId,
    severity: params.severity,
    templates: params.templates,
  })
}
