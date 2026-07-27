/**
 * First-run setup CLI.
 *
 *   bun run scripts/redscope-first-run.ts
 *   bun run scripts/redscope-first-run.ts --yes
 *   bun run scripts/redscope-first-run.ts --proxies-only
 *   bun run scripts/redscope-first-run.ts --pocs-only
 *   bun run scripts/redscope-first-run.ts --no
 *   bun run scripts/redscope-first-run.ts --status
 */

import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  executeFirstRunChoice,
  formatFirstRunStatus,
  getFirstRunPrompt,
  loadFirstRunState,
  type FirstRunChoice,
} from '../src/utils/firstRunSetup.ts'

function parseArgs(argv: string[]) {
  let choice: FirstRunChoice | null = null
  let status = false
  let help = false
  for (const a of argv) {
    if (a === '--yes' || a === '-y') choice = 'yes'
    else if (a === '--no') choice = 'no'
    else if (a === '--proxies-only') choice = 'proxies-only'
    else if (a === '--pocs-only') choice = 'pocs-only'
    else if (a === '--status') status = true
    else if (a === '--help' || a === '-h') help = true
  }
  return { choice, status, help }
}

async function promptChoice(): Promise<FirstRunChoice> {
  const prompt = getFirstRunPrompt()
  console.log('\n' + prompt.message + '\n')
  prompt.options.forEach((opt, i) => {
    console.log(`  [${i + 1}] ${opt.label}`)
  })
  const rl = readline.createInterface({ input, output })
  try {
    const answer = (await rl.question('\nChoose 1-4 [1]: ')).trim() || '1'
    const idx = Number(answer) - 1
    const opt = prompt.options[idx] ?? prompt.options[0]!
    return opt.id
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  bun run scripts/redscope-first-run.ts          # interactive
  bun run scripts/redscope-first-run.ts --yes    # proxies + pocs
  bun run scripts/redscope-first-run.ts --proxies-only
  bun run scripts/redscope-first-run.ts --pocs-only
  bun run scripts/redscope-first-run.ts --no
  bun run scripts/redscope-first-run.ts --status`)
    return
  }

  if (args.status) {
    console.log(formatFirstRunStatus(loadFirstRunState()))
    const prompt = getFirstRunPrompt()
    console.log(`needed=${prompt.needed} reason=${prompt.reason}`)
    return
  }

  const prompt = getFirstRunPrompt()
  if (!prompt.needed && !args.choice) {
    console.log(formatFirstRunStatus(prompt.state))
    console.log('Nothing to do. Pass --yes to re-run collection.')
    return
  }

  const choice = args.choice ?? (await promptChoice())
  console.log(`[first-run] executing choice=${choice} …`)
  const result = await executeFirstRunChoice(choice)
  for (const line of result.logs) console.log(`  ${line}`)
  console.log(formatFirstRunStatus(result.state))
}

main().catch(error => {
  console.error(
    `[first-run] fatal: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
