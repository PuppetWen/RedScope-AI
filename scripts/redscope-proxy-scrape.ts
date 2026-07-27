/**
 * Scrape public free-proxy list pages and build a ~500-node egress pool.
 *
 *   bun run scripts/redscope-proxy-scrape.ts
 *   bun run scripts/redscope-proxy-scrape.ts --limit 500
 *   bun run scripts/redscope-proxy-scrape.ts --status
 *
 * Intended for users who explicitly opt in (first-run prompt or this command).
 * Schedule via cron for automatic refresh, e.g. every 6 hours
 * (cron: minute=0, hour=every 6 hours).
 *
 *   bun run /path/to/redscope/scripts/redscope-proxy-scrape.ts --limit 500
 */

import {
  DEFAULT_PUBLIC_PROXY_TARGET,
  loadPublicProxyPool,
  refreshPublicProxyPool,
  getPublicProxyPoolPath,
  PUBLIC_PROXY_POOL_ID,
} from '../src/utils/publicProxyPool.ts'
import {
  formatEgressStatus,
  summarizeEgress,
  createEgressRotationState,
} from '../src/utils/egressPool.ts'

function parseArgs(argv: string[]) {
  let limit = DEFAULT_PUBLIC_PROXY_TARGET
  let status = false
  let help = false
  let timeoutMs = 8000
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit') limit = Number(argv[++i]) || limit
    else if (a === '--status') status = true
    else if (a === '--timeout-ms') timeoutMs = Number(argv[++i]) || timeoutMs
    else if (a === '--help' || a === '-h') help = true
  }
  return { limit, status, help, timeoutMs }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  bun run scripts/redscope-proxy-scrape.ts [--limit 500] [--timeout-ms 8000]
  bun run scripts/redscope-proxy-scrape.ts --status

Scrapes public free-proxy list pages and writes:
  ${getPublicProxyPoolPath()}
Pool id: ${PUBLIC_PROXY_POOL_ID}
Only use against authorized targets.`)
    return
  }

  if (args.status) {
    const config = loadPublicProxyPool()
    console.log(
      formatEgressStatus(
        summarizeEgress({
          config,
          state: createEgressRotationState(
            config?.egressPools[0]?.id ?? PUBLIC_PROXY_POOL_ID,
          ),
          nowMs: Date.now(),
        }),
      ),
    )
    console.log(`  path=${getPublicProxyPoolPath()}`)
    return
  }

  console.log(
    `[proxy-scrape] fetching public free-proxy lists (limit=${args.limit})…`,
  )
  const { result, config } = await refreshPublicProxyPool({
    limit: args.limit,
    timeoutMs: args.timeoutMs,
  })
  console.log(
    `[proxy-scrape] sources ${result.sourcesOk}/${result.sourcesAttempted} ok · raw=${result.rawParsed} · unique≈${result.unique} · kept=${result.kept}`,
  )
  if (result.errors.length) {
    console.log(`[proxy-scrape] ${result.errors.length} source error(s):`)
    for (const err of result.errors.slice(0, 8)) {
      console.log(`  - ${err}`)
    }
  }
  console.log(
    `[proxy-scrape] wrote pool ${config.egressPools[0]?.id} with ${result.kept} nodes → ${getPublicProxyPoolPath()}`,
  )
  console.log(
    '[proxy-scrape] tip: bun run redscope:egress-refresh -- --config ' +
      getPublicProxyPoolPath() +
      ' --check',
  )
}

main().catch(error => {
  console.error(
    `[proxy-scrape] fatal: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
