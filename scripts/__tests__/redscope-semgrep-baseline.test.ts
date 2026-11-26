import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const profile = 'authorized-semgrep-sast'
const base = 'a1'.repeat(20)
let fixture: string

beforeAll(async () => {
  // The runner resolves its installation manifest against its own project root.
  // Isolate that root so the test never changes the user's installed tools.
  fixture = await mkdtemp(join(root, '.semgrep-plan-test-'))
  for (const dir of ['scripts', 'tools/manifests', 'repo']) {
    await mkdir(join(fixture, dir), { recursive: true })
  }
  for (const entry of ['profile-runner', 'workflow', 'command-adapter', 'batch-runner', 'semgrep-options']) {
    const file = `scripts/redscope-${entry}.ts`
    await copyFile(join(root, file), join(fixture, file))
  }
  for (const dependency of ['env-config', 'egress-runtime', 'source-updater']) {
    const name = `redscope-${dependency}.ts`
    await writeFile(join(fixture, 'scripts', name), `export * from '../../scripts/${name}'\n`)
  }
  const registry = 'tools/redscope-run-profiles.json'
  await copyFile(join(root, registry), join(fixture, registry))
  await writeFile(join(fixture, 'tools/manifests/semgrep.json'), JSON.stringify({
    tool: { id: 'semgrep' }, install: { executablePath: 'tools/not-installed' },
  }))
  await writeFile(join(fixture, 'repo/.semgrep.yml'), 'rules: []\n')
  await writeFile(join(fixture, 'repositories.txt'), 'repo\n')
  await writeFile(join(fixture, 'scope.json'), JSON.stringify({
    owner: 'Reviewer', authorization: { authorizedBy: 'Test', validFrom: '2020-01-01',
      validTo: '2099-12-31', emergencyContact: 'qa@example.test' },
    testLevels: ['restricted'], rateLimits: { requestsPerSecond: 0, concurrency: 1 },
    scannerExecution: { approvedBy: 'Test', approvalReference: 'fixture', changeWindow: 'test', allowedTools: ['semgrep'] },
    targets: { repositories: ['repo'] },
  }))
})

afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }) })

async function dryRun(entry: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, `scripts/redscope-${entry}.ts`, '--scope', 'scope.json', '--dry-run', '--json', ...args], {
    cwd: fixture, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, REDSCOPE_CONFIG_DIR: join(fixture, 'config'), CLAUDE_CONFIG_DIR: join(fixture, 'legacy') },
  })
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(err || out)
  return JSON.parse(out)
}

test('single-profile dry-run includes the complete baseline SHA and disables the version check', async () => {
  const args = ['--profile', profile, '--repository', 'repo']
  for (const sha of [base, 'BC'.repeat(32)]) {
    const plan = await dryRun('profile-runner', [...args, '--semgrep-baseline', sha])
    const command = plan.commands[0]
    expect(command.status).toBe('planned')
    expect(command.cwd).toBe('repo')
    expect(command.argv.slice(-6)).toEqual(['--metrics', 'off', '--disable-version-check', '--baseline-commit', sha, join(fixture, 'repo')])
  }
  const full = await dryRun('profile-runner', args)
  expect(full.commands[0].argv).toContain('--disable-version-check')
  expect(full.commands[0].argv).not.toContain('--baseline-commit')
})

test('limits baseline mode to a full Git object ID and the local Semgrep repository profile', async () => {
  for (const sha of ['HEAD~1', 'deadbeef', 'z'.repeat(40)]) {
    await expect(dryRun('profile-runner', ['--profile', profile, '--repository', 'repo', '--semgrep-baseline', sha]))
      .rejects.toThrow('full 40- or 64-character')
  }
  await expect(dryRun('profile-runner', ['--profile', 'authorized-gitleaks-secret-scan', '--repository', 'repo', '--semgrep-baseline', base]))
    .rejects.toThrow('requires the authorized-semgrep-sast')
  await expect(dryRun('batch-runner', ['--profile', profile, '--targets', 'repositories.txt', '--semgrep-baseline', base]))
    .rejects.toThrow('requires --target-kind repository')
  const scope = JSON.parse(await readFile(join(fixture, 'scope.json'), 'utf8'))
  scope.scannerExecution.allowedTools = ['gitleaks']
  await writeFile(join(fixture, 'denied.json'), JSON.stringify(scope))
  const denied = await dryRun('profile-runner', ['--profile', profile, '--scope', 'denied.json',
    '--repository', 'repo', '--semgrep-baseline', base])
  expect(denied.commands[0].status).toBe('skipped')
  expect(denied.commands[0].reason).toContain('not listed in scope.scannerExecution.allowedTools')
})

test('command, workflow and repository batch forward the selected baseline', async () => {
  const adapter = await dryRun('command-adapter', ['--semgrep-sast', '--repository', 'repo', '--semgrep-baseline', base])
  expect(adapter.status).toBe('completed')
  expect(adapter.workflow.stages.profile.command).toContain('--semgrep-baseline')
  expect(adapter.workflow.stages.profile.command).toContain(base)
  const batch = await dryRun('batch-runner', ['--profile', profile, '--target-kind', 'repository',
    '--targets', 'repositories.txt', '--semgrep-baseline', base])
  expect(batch.runs[0].status).toBe('completed')
  expect(batch.runs[0].command).toContain('--semgrep-baseline')
  expect(batch.runs[0].command).toContain(base)
})
