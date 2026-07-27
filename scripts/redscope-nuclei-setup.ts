/**
 * Download nuclei into the current project's tools/bin and print status.
 *
 *   bun run scripts/redscope-nuclei-setup.ts
 *   bun run scripts/redscope-nuclei-setup.ts --status
 *   bun run scripts/redscope-nuclei-setup.ts --yes
 */

import {
  detectNuclei,
  downloadNucleiToWorkspace,
  formatNucleiStatus,
  buildNucleiMissingPrompt,
  getNucleiInstallDir,
} from '../src/utils/nucleiTool.ts'

function parseArgs(argv: string[]) {
  return {
    status: argv.includes('--status'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  bun run scripts/redscope-nuclei-setup.ts          # install if missing
  bun run scripts/redscope-nuclei-setup.ts --status
  bun run scripts/redscope-nuclei-setup.ts --yes

Installs ProjectDiscovery nuclei into:
  ${getNucleiInstallDir()}
Only use against authorized targets.`)
    return
  }

  const presence = detectNuclei()
  if (args.status) {
    console.log(formatNucleiStatus(presence))
    if (!presence.available) {
      console.log('\n' + buildNucleiMissingPrompt().message)
    }
    return
  }

  if (presence.available) {
    console.log(formatNucleiStatus(presence))
    console.log('[nuclei-setup] already installed — nothing to do.')
    return
  }

  console.log(buildNucleiMissingPrompt().message)
  console.log('\n[nuclei-setup] downloading latest release into tools/bin …')
  const path = await downloadNucleiToWorkspace()
  if (!path) {
    console.error(
      '[nuclei-setup] download failed. Check network / GitHub access, or install manually from https://github.com/projectdiscovery/nuclei/releases',
    )
    process.exitCode = 1
    return
  }
  const after = detectNuclei()
  console.log(`[nuclei-setup] installed: ${path}`)
  console.log(formatNucleiStatus(after))
}

main().catch(error => {
  console.error(
    `[nuclei-setup] fatal: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
