import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const testPrefix = join(repoRoot, 'tools', 'tmp-delivery-html-')
let testRoot: string
let runDir: string

beforeEach(async () => {
  testRoot = await mkdtemp(testPrefix)
  runDir = join(testRoot, 'run')
  await mkdir(runDir)
  await writeFile(join(runDir, 'run.json'), '{}')
  await writeFile(join(runDir, 'report.md'), '# Original report\n\n<original-text>')
})

afterEach(async () => {
  if (testRoot && resolve(testRoot).startsWith(testPrefix)) {
    await rm(testRoot, { recursive: true, force: true })
  }
})

async function deliver(findings: unknown[], evidence: unknown[], args: string[] = []) {
  await writeFile(join(runDir, 'findings.json'), JSON.stringify({ findings }))
  await writeFile(join(runDir, 'evidence-index.json'), JSON.stringify({ evidence }))
  const processResult = Bun.spawn([
    process.execPath, 'scripts/redscope-delivery.ts', '--run', runDir,
    '--output-root', testRoot, ...args,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      REDSCOPE_CONFIG_DIR: join(testRoot, '.redscope'),
      CLAUDE_CONFIG_DIR: join(testRoot, '.claude'),
      BUN_INSTALL_CACHE_DIR: join(testRoot, 'cache'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      TMP: testRoot,
      TEMP: testRoot,
      TMPDIR: testRoot,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [code, error] = await Promise.all([
    processResult.exited,
    new Response(processResult.stderr).text(),
  ])
  if (code !== 0) throw new Error(error || `Delivery exited with code ${code}`)
  return readFile(join(runDir, 'delivery', 'report.html'), 'utf8')
}

test('empty review retains the original report body', async () => {
  const html = await deliver([], [])
  expect(html).toContain('No findings to review.')
  expect(html).toContain('No indexed evidence.')
  expect(html).toContain('Original report')
  expect(html).toContain('&lt;original-text&gt;')
})

test('manual triage, evidence locations and unresolved references are visible offline', async () => {
  const overrides = join(testRoot, 'overrides.json')
  await writeFile(overrides, JSON.stringify({
    findings: { 'F-1': { triageStatus: 'fixed', owner: 'QA & Audit', note: '<review-note>' } },
  }))
  const path = 'raw/summary.json'
  const sha256 = 'c'.repeat(64)
  const html = await deliver([
    {
      id: 'F-1', title: '<fixed-title>', severity: 'high',
      evidence: [
        { id: 'E-1', path, jsonPointer: '/check/<item>', line: 4 },
        { id: 'E-missing', path: 'missing.json' },
      ],
    },
    { title: 'Legacy finding', severity: 'low', evidence: [{ path }] },
  ], [{ id: 'E-1', path, sha256 }], ['--triage-file', overrides])

  expect(html).toContain('<strong>Needs review</strong>1')
  expect(html.indexOf('Legacy finding')).toBeGreaterThan(-1)
  expect(html.indexOf('Legacy finding')).toBeLessThan(html.indexOf('&lt;fixed-title&gt;'))
  expect(html).toContain('fixed</strong>')
  expect(html).toContain('QA &amp; Audit')
  expect(html).toContain('&lt;review-note&gt;')
  expect(html).not.toContain('<review-note>')
  expect(html).toContain('line 4')
  expect(html).toContain('/check/&lt;item&gt;')
  expect(html.match(/href="#review-evidence-0"/g)).toHaveLength(2)
  expect(html).toContain('id="review-evidence-0"')
  expect(html).toContain(sha256)
  expect(html).toContain('E-missing (unresolved reference)')
  expect(html).not.toContain('href="raw/')
})
