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

beforeEach(async () => {
  testRoot = join(
    repoRoot,
    'tools',
    `tmp-batch-runner-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true })
  }
})

describe('redscope-batch-runner', () => {
  test('runs an arbitrary-size target list and writes a batch manifest', async () => {
    const scopePath = join(testRoot, 'scope.json')
    const targetsPath = join(testRoot, 'targets.txt')
    const outputRoot = join(testRoot, 'outputs')
    const memoryRoot = join(testRoot, 'memory')
    const batchOutputRoot = join(testRoot, 'batches')

    await writeJson(scopePath, {
      program: 'Batch runner test',
      owner: 'RedScope QA',
      authorization: {
        authorizedBy: 'Unit Test',
        validFrom: '2020-01-01',
        validTo: '2099-12-31',
        emergencyContact: 'security@example.com',
      },
      testLevels: ['active'],
      rateLimits: {
        requestsPerSecond: 1,
        concurrency: 1,
      },
      targets: {
        urls: ['https://example.com/'],
      },
      validation: {
        approvedBy: 'Unit Test',
        approvalReference: 'UT-LOW-IMPACT',
        validators: [
          {
            id: 'headers',
            title: 'Header metadata check',
            target: 'https://example.com/',
            method: 'HEAD',
            path: '/',
            expectedStatus: 200,
          },
        ],
      },
    })
    await writeFile(
      targetsPath,
      [
        '# referee list can be shorter or longer than 20',
        'https://example.com/',
        'https://example.com/login',
        '',
      ].join('\n'),
    )

    const proc = Bun.spawn(
      [
        process.execPath,
        'scripts/redscope-batch-runner.ts',
        '--profile',
        'authorized-low-impact-validator',
        '--scope',
        projectPath(scopePath),
        '--targets',
        projectPath(targetsPath),
        '--output-root',
        projectPath(outputRoot),
        '--memory-root',
        projectPath(memoryRoot),
        '--batch-output',
        projectPath(batchOutputRoot),
        '--skip-report',
        '--skip-observe',
        '--json',
      ],
      {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      throw new Error(stderr || stdout)
    }
    const result = JSON.parse(stdout) as {
      targetCount: number
      processedCount: number
      summary: {
        completed: number
        failed: number
        blocked: number
        evidenceDirs: string[]
      }
      batchManifest: string
    }

    expect(result.targetCount).toBe(2)
    expect(result.processedCount).toBe(2)
    expect(result.summary.completed).toBe(2)
    expect(result.summary.failed).toBe(0)
    expect(result.summary.blocked).toBe(0)
    expect(result.summary.evidenceDirs).toHaveLength(2)

    const manifest = JSON.parse(
      await readFile(resolve(repoRoot, result.batchManifest), 'utf8'),
    ) as { safety: { variableTargetCount: boolean } }
    expect(manifest.safety.variableTargetCount).toBe(true)
  })
})
