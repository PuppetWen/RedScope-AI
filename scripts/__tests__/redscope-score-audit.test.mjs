import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const script = join(repoRoot, 'scripts', 'redscope-score-audit.mjs')

async function fixture(t) {
  const dir = await mkdtemp(join(repoRoot, 'tools', 'tmp-score-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const labels = join(dir, 'labels.json')
  return async (findings, cases) => {
    await writeFile(join(dir, 'findings.json'), JSON.stringify({ schemaVersion: 1, findings }))
    await writeFile(labels, '\uFEFF' + JSON.stringify({ cases }))
    const child = spawnSync(process.execPath, [script, '--labels', labels, '--run', dir], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir },
    })
    assert.ifError(child.error)
    return child
  }
}

function label(line, expected) {
  return { sourceTool: 'semgrep', ruleId: 'lint.path', target: `src/input.ts:${line}`, expected }
}

function finding(line) {
  return { category: 'static-analysis', sourceTool: 'semgrep', ruleId: 'lint.path', target: `src/input.ts:${line}` }
}

test('scores the four outcomes on labeled cases only and deduplicates by tool, rule and exact location', async t => {
  const run = await fixture(t)
  const cases = [label(1, true), label(2, false), label(3, true), label(4, false)]
  const legacy = { ...finding(1), title: 'Semgrep finding: lint.path' }
  delete legacy.ruleId
  const result = await run([
    legacy, finding(1), finding(2),
    finding(5), finding(5), { ...finding(5), sourceTool: 'AnotherTool' },
    { ...finding(3), category: 'secret-scanning' },
    { ...finding(3), target: 'no-line.ts' },
    { ...legacy, title: 'Semgrep finding: semgrep-rule' },
    { ...legacy, sourceTool: 'NotSemgrep' },
  ], cases)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.confusion, { tp: 1, fp: 1, tn: 1, fn: 1 })
  assert.equal(report.basis, 'labeled-static-analysis-cases')
  assert.equal(report.labeledCases, 4)
  assert.equal(report.precision, 0.5)
  assert.equal(report.recall, 0.5)
  assert.equal(report.duplicateFindings, 2)
  assert.equal(report.unlabeledMatches, 2)
  assert.equal(report.unlabeledLocations, 1)
  assert.equal(report.unscorableFindings, 3)
  assert.deepEqual(report.unscorable, [
    { index: 7, invalidFields: ['target'] },
    { index: 8, invalidFields: ['ruleId'] },
    { index: 9, invalidFields: ['ruleId'] },
  ])
  const { expected: ignoredFp, ...fp } = cases[1]
  const { expected: ignoredFn, ...fn } = cases[2]
  assert.deepEqual(report.falsePositives, [fp])
  assert.deepEqual(report.falseNegatives, [fn])
})

test('empty label set yields undefined precision and recall, never an implied zero', async t => {
  const run = await fixture(t)
  const result = await run([finding(1)], [])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.confusion, { tp: 0, fp: 0, tn: 0, fn: 0 })
  assert.equal(report.precision, null)
  assert.equal(report.recall, null)
  assert.equal(report.unlabeledMatches, 1)
})

test('rejects malformed labels, a malformed report, and both conflicting and repeated labels', async t => {
  const run = await fixture(t)
  for (const cases of [
    [label(1, true), label(1, false)],
    [label(1, true), label(1, true)],
    [label(0, true)],
    [label(1, 'true')],
    [{ ...label(1, true), target: 'unknown file:1' }],
    [{ ...label(1, true), ruleId: ' ' }],
    null,
  ]) {
    assert.equal((await run([], cases)).status, 1)
  }
  assert.equal((await run(null, [])).status, 1)
  assert.equal((await run([null], [])).status, 1)
})
