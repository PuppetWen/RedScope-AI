import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
let testRoot = ''

function projectPath(path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function runProfile(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'scripts/redscope-profile-runner.ts', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr || stdout)
  }
  return JSON.parse(stdout) as {
    dryRun: true
    profile: string
    commands: Array<{
      stepId: string
      tool?: string
      status: string
      reason?: string
    }>
  }
}

beforeEach(async () => {
  testRoot = join(
    repoRoot,
    'tools',
    `tmp-scanner-profile-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true })
  }
})

describe('restricted scanner profiles', () => {
  test('Gitleaks and Semgrep profiles require per-tool scanner allowlisting', async () => {
    const scopePath = join(testRoot, 'scope.json')
    const repoPath = join(testRoot, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, '.semgrep.yml'), 'rules: []\n')
    await writeJson(scopePath, {
      program: 'Scanner profile test',
      owner: 'RedScope QA',
      authorization: {
        authorizedBy: 'Unit Test',
        validFrom: '2020-01-01',
        validTo: '2099-12-31',
        emergencyContact: 'security@example.com',
      },
      testLevels: ['restricted'],
      rateLimits: {
        requestsPerSecond: 0,
        concurrency: 1,
      },
      scannerExecution: {
        approvedBy: 'Unit Test',
        approvalReference: 'UT-SCANNER-001',
        changeWindow: 'Unit test local-only scan window',
        allowedTools: ['gitleaks'],
      },
      targets: {
        repositories: [projectPath(repoPath)],
      },
    })

    const gitleaks = await runProfile([
      '--profile',
      'authorized-gitleaks-secret-scan',
      '--scope',
      projectPath(scopePath),
      '--repository',
      projectPath(repoPath),
      '--dry-run',
      '--json',
    ])

    expect(gitleaks.profile).toBe('authorized-gitleaks-secret-scan')
    expect(gitleaks.commands).toHaveLength(1)
    expect(gitleaks.commands[0]?.tool).toBe('gitleaks')
    expect(gitleaks.commands[0]?.reason).toContain('no installed manifest')

    const semgrep = await runProfile([
      '--profile',
      'authorized-semgrep-sast',
      '--scope',
      projectPath(scopePath),
      '--repository',
      projectPath(repoPath),
      '--dry-run',
      '--json',
    ])

    expect(semgrep.profile).toBe('authorized-semgrep-sast')
    expect(semgrep.commands).toHaveLength(1)
    expect(semgrep.commands[0]?.tool).toBe('semgrep')
    expect(semgrep.commands[0]?.status).toBe('skipped')
    expect(semgrep.commands[0]?.reason).toBe(
      'tool semgrep is not listed in scope.scannerExecution.allowedTools',
    )
  })
})
