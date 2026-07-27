#!/usr/bin/env node
/**
 * Postinstall bootstrap — after `npm i -g @redscope-ai/redscope` / local install,
 * silently prepare:
 *   1. ~500 public free-proxy nodes (IP rotation pool)
 *   2. ≥100 PoC / n-day advisory references (not printed)
 *
 * Non-fatal: never fails the parent install.
 *
 * Skip with:
 *   REDSCOPE_SKIP_FIRST_RUN_BOOTSTRAP=1
 *
 * Force re-run:
 *   REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP=1
 */

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { spawnSync } = require('child_process')
const path = require('path')
const os = require('os')

const projectRoot = path.resolve(__dirname, '..')
const configDir =
  process.env.REDSCOPE_CONFIG_DIR || path.join(os.homedir(), '.redscope')
const firstRunPath = path.join(configDir, 'first-run.json')
const proxyPoolPath = path.join(configDir, 'public-free-proxies.json')

function log(msg) {
  console.log(`[redscope-bootstrap] ${msg}`)
}

function readFirstRun() {
  try {
    if (!existsSync(firstRunPath)) return null
    return JSON.parse(readFileSync(firstRunPath, 'utf-8'))
  } catch {
    return null
  }
}

function writeFirstRun(state) {
  try {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(firstRunPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  } catch (error) {
    log(
      `could not write first-run state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function runBunScript(relScripts, args = [], cwd = projectRoot) {
  const candidates = Array.isArray(relScripts) ? relScripts : [relScripts]
  const relScript = candidates.find(candidate =>
    existsSync(path.join(projectRoot, candidate)),
  )
  if (!relScript) {
    log(`skip missing scripts ${candidates.join(', ')}`)
    return { ok: false, code: 127 }
  }
  const scriptPath = path.join(projectRoot, relScript)
  if (!existsSync(scriptPath)) {
    log(`skip missing script ${relScript}`)
    return { ok: false, code: 127 }
  }
  // Prefer bun, fall back to npx bun / node won't run .ts directly
  const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const result = spawnSync(bunCmd, ['run', scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env },
  })
  if (result.error) {
    log(`${relScript} spawn error: ${result.error.message}`)
    return { ok: false, code: 1, error: result.error }
  }
  if (result.stdout && result.stdout.trim()) {
    // Keep output compact — one summary line if possible
    const lines = result.stdout.trim().split(/\r?\n/)
    log(lines[lines.length - 1] || `${relScript} done`)
  }
  if (result.status !== 0 && result.stderr) {
    const errLine = result.stderr.trim().split(/\r?\n/).slice(-1)[0]
    if (errLine) log(errLine)
  }
  return { ok: result.status === 0, code: result.status ?? 1 }
}

function proxyCountFromDisk() {
  try {
    if (!existsSync(proxyPoolPath)) return 0
    const raw = JSON.parse(readFileSync(proxyPoolPath, 'utf-8'))
    const pools = Array.isArray(raw.egressPools) ? raw.egressPools : []
    return pools.reduce(
      (n, p) => n + (Array.isArray(p.nodes) ? p.nodes.length : 0),
      0,
    )
  } catch {
    return 0
  }
}

function pocCountFromWorkspace() {
  const candidates = [
    path.join(configDir, 'redscope-poc-catalog.json'),
    path.join(projectRoot, 'redscope-poc-catalog.json'),
    path.join(process.cwd(), 'redscope-poc-catalog.json'),
  ]
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (Array.isArray(raw.entries)) return raw.entries.length
    } catch {
      /* try next */
    }
  }
  return 0
}

function main() {
  if (process.env.REDSCOPE_SKIP_FIRST_RUN_BOOTSTRAP === '1') {
    log('skipped (REDSCOPE_SKIP_FIRST_RUN_BOOTSTRAP=1)')
    return
  }

  // CI / offline packaging often sets this
  if (process.env.CI === 'true' && process.env.REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP !== '1') {
    log('skipped in CI (set REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP=1 to override)')
    return
  }

  const force = process.env.REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP === '1'
  const existing = readFirstRun()
  const proxies = proxyCountFromDisk()
  const pocs = pocCountFromWorkspace()

  if (
    !force &&
    existing &&
    existing.completedAt &&
    proxies >= 50 &&
    pocs >= 100
  ) {
    log(
      `already bootstrapped (proxies≈${proxies}, pocs≈${pocs}) — skip. Use REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP=1 to redo.`,
    )
    return
  }

  log('first install bootstrap: public IPs (~500) + silent PoC catalog (≥100)…')
  log('only use against authorized targets. Set REDSCOPE_SKIP_FIRST_RUN_BOOTSTRAP=1 to skip next time.')

  // 1) PoC catalog (local generator, no network required for the bundled list)
  mkdirSync(configDir, { recursive: true })
  const pocResult = runBunScript(
    ['dist/scripts/gen-poc-catalog.js', 'scripts/gen-poc-catalog.ts'],
    [],
    configDir,
  )
  const pocTotal = pocCountFromWorkspace()

  // 2) Public proxy scrape (network — best effort)
  const proxyResult = runBunScript(
    [
      'dist/scripts/redscope-proxy-scrape.js',
      'scripts/redscope-proxy-scrape.ts',
    ],
    ['--limit', '500'],
  )
  const proxyTotal = proxyCountFromDisk()

  writeFirstRun({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    askedAt: new Date().toISOString(),
    scrapeProxies: true,
    collectPocs: true,
    proxyCount: proxyTotal,
    pocCount: pocTotal,
    lastProxyRefreshAt: proxyTotal > 0 ? new Date().toISOString() : undefined,
    lastPocRefreshAt: pocTotal > 0 ? new Date().toISOString() : undefined,
    notes: [
      'Auto-completed by npm/bun postinstall bootstrap.',
      `pocScript=${pocResult.ok ? 'ok' : 'fail'} proxyScript=${proxyResult.ok ? 'ok' : 'fail'}`,
    ],
  })

  log(
    `done · proxies=${proxyTotal} · pocs=${pocTotal} (details hidden) · state=${firstRunPath}`,
  )
}

try {
  main()
} catch (error) {
  log(
    `non-fatal failure: ${error instanceof Error ? error.message : String(error)}`,
  )
}
process.exit(0)
