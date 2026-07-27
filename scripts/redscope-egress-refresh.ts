/**
 * Authorized egress pool refresh + health rotation helper.
 *
 * This script NEVER scrapes public free-proxy lists. Project policy
 * (`disallowPublicFreeProxies`) forbids augmenting the referee-provided pool
 * with anonymous third-party relays. Instead it:
 *
 *   1. Loads the authorized/referee-provided egress config
 *   2. Health-checks each enabled node (TCP connect / optional HTTP probe)
 *   3. Records healthy/unhealthy outcomes into the rotation state
 *   4. Optionally selects the next egress node for a target and persists it
 *
 * Intended usage (manual or cron):
 *
 *   bun run scripts/redscope-egress-refresh.ts --check
 *   bun run scripts/redscope-egress-refresh.ts --select --target 203.0.113.10
 *   bun run scripts/redscope-egress-refresh.ts --status
 *
 * For scheduled refresh, wire a durable cron that runs `--check` on the
 * interval from policy.defaultRefreshIntervalDays (default 1 day).
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyEgressHealthResult,
  beginEgressStep,
  formatEgressStatus,
  getEgressStatePath,
  loadEgressConfig,
  loadEgressRotationState,
  normalizeEgressConfig,
  resolveEgressPool,
  saveEgressRotationState,
  selectAndPersistEgressNode,
  summarizeEgress,
  type EgressConfig,
  type EgressNode,
  type EgressRotationState,
} from '../src/utils/egressPool.ts'
import { getExistingRefereeEgressConfigFilePath } from '../src/utils/authorizedEgressConfig.ts'

type Args = {
  check: boolean
  select: boolean
  status: boolean
  target?: string
  poolId?: string
  timeoutMs: number
  configPath?: string
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    check: false,
    select: false,
    status: false,
    timeoutMs: 3000,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') args.check = true
    else if (a === '--select') args.select = true
    else if (a === '--status') args.status = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '--target') args.target = argv[++i]
    else if (a === '--pool') args.poolId = argv[++i]
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]) || 3000
    else if (a === '--config') args.configPath = argv[++i]
  }
  if (!args.check && !args.select && !args.status) args.status = true
  return args
}

function loadConfig(configPath?: string): EgressConfig | null {
  if (configPath) {
    const abs = resolve(process.cwd(), configPath)
    if (!existsSync(abs)) {
      console.error(`[egress-refresh] config not found: ${abs}`)
      return null
    }
    try {
      return normalizeEgressConfig(JSON.parse(readFileSync(abs, 'utf-8')))
    } catch (error) {
      console.error(
        `[egress-refresh] failed to parse ${abs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return null
    }
  }
  // Prefer user config path helper, then the bundled referee template in-repo.
  const existing = getExistingRefereeEgressConfigFilePath()
  if (existing) return loadEgressConfig()
  const bundled = resolve(
    process.cwd(),
    'tools/authorized-egress.referee-provided.json',
  )
  if (existsSync(bundled)) {
    try {
      return normalizeEgressConfig(JSON.parse(readFileSync(bundled, 'utf-8')))
    } catch {
      return null
    }
  }
  return loadEgressConfig()
}

async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const { connect } = await import('node:net')
  return new Promise(resolvePromise => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolvePromise({ ok: false, reason: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolvePromise({ ok: true, reason: 'tcp-connect-ok' })
    })
    socket.once('error', err => {
      clearTimeout(timer)
      resolvePromise({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      })
    })
  })
}

async function healthCheckNode(
  node: EgressNode,
  timeoutMs: number,
): Promise<{ healthy: boolean; reason: string }> {
  const result = await tcpProbe(node.host, node.port, timeoutMs)
  return { healthy: result.ok, reason: result.reason }
}

async function runCheck(
  config: EgressConfig,
  state: EgressRotationState,
  statePath: string,
  poolId: string | undefined,
  timeoutMs: number,
  nowMs: number,
): Promise<void> {
  const pool = resolveEgressPool(config, poolId ?? state.poolId)
  if (!pool) {
    console.error('[egress-refresh] no pool resolved')
    return
  }
  if (config.policy.disallowPublicFreeProxies) {
    console.log(
      '[egress-refresh] policy.disallowPublicFreeProxies=true — will NOT scrape public free proxies; health-checking authorized nodes only',
    )
  }
  const enabled = pool.nodes.filter(n => n.enabled)
  console.log(
    `[egress-refresh] checking ${enabled.length} enabled node(s) in pool ${pool.id}`,
  )
  let healthy = 0
  let unhealthy = 0
  for (const node of enabled) {
    const result = await healthCheckNode(
      node,
      timeoutMs || config.policy.connectivityCheckTimeoutMs,
    )
    applyEgressHealthResult({
      policy: config.policy,
      state,
      statePath,
      nodeId: node.id,
      healthy: result.healthy,
      nowMs,
    })
    if (result.healthy) {
      healthy += 1
      console.log(`  ✓ ${node.id} ${node.endpoint} — ${result.reason}`)
    } else {
      unhealthy += 1
      console.log(`  ✗ ${node.id} ${node.endpoint} — ${result.reason}`)
    }
  }
  console.log(
    `[egress-refresh] done: healthy=${healthy} unhealthy=${unhealthy} (cooled for ${config.policy.blockedCooldownHours}h)`,
  )
}

async function runSelect(
  config: EgressConfig,
  state: EgressRotationState,
  statePath: string,
  poolId: string | undefined,
  target: string | undefined,
  nowMs: number,
): Promise<void> {
  beginEgressStep(state, nowMs)
  const outcome = selectAndPersistEgressNode({
    config,
    state,
    statePath,
    poolId,
    target,
    nowMs,
  })
  if (!outcome.ok) {
    console.error(`[egress-refresh] select failed: ${outcome.reason}`)
    process.exitCode = 2
    return
  }
  console.log(
    `[egress-refresh] selected ${outcome.node.id} ${outcome.node.endpoint}` +
      (outcome.node.sourceIp ? ` sourceIp=${outcome.node.sourceIp}` : '') +
      (outcome.persisted ? ' (persisted)' : ` (persist failed: ${outcome.persistError})`),
  )
}

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/redscope-egress-refresh.ts --status
  bun run scripts/redscope-egress-refresh.ts --check [--timeout-ms 3000]
  bun run scripts/redscope-egress-refresh.ts --select [--target HOST] [--pool POOL_ID]
  bun run scripts/redscope-egress-refresh.ts --config path/to/authorized-egress.json ...

Notes:
  - Public free-proxy scraping is intentionally unsupported.
  - Only referee/authorized pool nodes are health-checked and rotated.
  - Schedule --check via cron using policy.defaultRefreshIntervalDays.`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const config = loadConfig(args.configPath)
  if (!config) {
    console.error(
      '[egress-refresh] no authorized egress config found. Copy tools/authorized-egress.referee-provided.json to ~/.redscope/ or pass --config.',
    )
    process.exitCode = 1
    return
  }

  // Hard refuse if policy was somehow flipped to allow public free proxies —
  // this script is not a scraper and will not become one.
  if (config.policy.disallowPublicFreeProxies === false) {
    console.warn(
      '[egress-refresh] WARNING: disallowPublicFreeProxies=false is set, but this script still refuses public free-proxy collection.',
    )
  }

  const statePath = getEgressStatePath(config)
  const state = loadEgressRotationState(statePath)
  const nowMs = Date.now()

  if (args.status) {
    console.log(
      formatEgressStatus(
        summarizeEgress({
          config,
          state,
          poolId: args.poolId,
          nowMs,
        }),
      ),
    )
    console.log(`  statePath=${statePath}`)
    console.log(
      `  refreshIntervalDays=${config.policy.defaultRefreshIntervalDays}`,
    )
  }

  if (args.check) {
    await runCheck(
      config,
      state,
      statePath,
      args.poolId,
      args.timeoutMs,
      nowMs,
    )
  }

  if (args.select) {
    await runSelect(config, state, statePath, args.poolId, args.target, nowMs)
  }

  // Always flush state after mutations even if individual helpers already did.
  saveEgressRotationState(statePath, state)
}

main().catch(error => {
  console.error(
    `[egress-refresh] fatal: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exitCode = 1
})
