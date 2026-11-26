import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

async function createRun(t, findings = [{ id: 'F1', status: 'confirmed' }]) {
  const folder = await mkdtemp(join(root, '.triage-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const run = join(folder, 'run')
  await mkdir(run)
  await Promise.all([
    writeFile(join(run, 'run.json'), '{}'),
    writeFile(join(run, 'findings.json'), JSON.stringify({ findings })),
    writeFile(join(run, 'evidence-index.json'), '{"evidence":[]}'),
    writeFile(join(run, 'report.md'), '# Test report\n'),
  ])

  return {
    delivery: join(run, 'delivery'),
    async deliver(raw) {
      const triage = join(folder, 'input.json')
      await writeFile(triage, raw)
      return spawnSync(process.versions.bun ? process.execPath : 'bun', [
        join(root, 'scripts/redscope-delivery.ts'),
        '--run', run, '--output-root', folder, '--triage-file', triage, '--force', '--skip-html',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          REDSCOPE_CONFIG_DIR: join(folder, 'config'),
          CLAUDE_CONFIG_DIR: join(folder, 'legacy-config'),
          TMP: folder,
          TEMP: folder,
          TMPDIR: folder,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        },
      })
    },
  }
}

test('array and keyed overrides preserve status, owner and reviewer notes', async t => {
  const fixture = await createRun(t)
  const review = { owner: '  Analyst  ', triageStatus: 'fixed', reviewerNotes: ['Checked'], note: '已修复' }
  for (const findings of [[{ id: 'F1', ...review }], { F1: review }, { F1: { id: 'F1', ...review } }]) {
    const result = await fixture.deliver('\uFEFF' + JSON.stringify({ findings }))
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(await readFile(join(fixture.delivery, 'triage.json'), 'utf8'))
    assert.equal(output.summary.needsReview, 0)
    assert.equal(output.findings[0].triageStatus, 'fixed')
    assert.equal(output.findings[0].owner, 'Analyst')
    assert.deepEqual(output.findings[0].reviewerNotes, ['Checked', '已修复'])
  }
})

test('malformed overrides fail before delivery files are written', async t => {
  const fixture = await createRun(t)
  const cases = [
    ['[]', /JSON object/],
    ['{"findings":null}', /array or an object/],
    ['{"findings":[{}]}', /nonempty finding ID/],
    ['{"findings":[{"id":"F1"},{"id":"F1"}]}', /duplicate finding ID/],
    ['{"findings":{"F1":{},"F1":{}}}', /duplicate finding ID/],
    ['{"findings":{"F1":{"id":"F2"}}}', /conflicts with the object key/],
    ['{"findings":{"F2":{}}}', /unknown finding ID/],
    ['{"findings":{"F1":{"triageStatus":"typo"}}}', /triageStatus/],
    ['{"findings":{"F1":{"owner":false}}}', /owner/],
    ['{"findings":{"F1":{"reviewerNotes":[3]}}}', /reviewerNotes/],
    ['{"findings":{"F1":{"note":null}}}', /note/],
  ]
  for (const [raw, expected] of cases) {
    const result = await fixture.deliver(raw)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, expected)
    assert.equal(existsSync(fixture.delivery), false)
  }
})

test('empty override documents retain defaults, and a failed retry preserves prior triage', async t => {
  const fixture = await createRun(t)
  const triagePath = join(fixture.delivery, 'triage.json')
  for (const raw of ['{}', '{"findings":[]}', '{"findings":{}}']) {
    const result = await fixture.deliver(raw)
    assert.equal(result.status, 0, result.stderr)
    const previous = JSON.parse(await readFile(triagePath, 'utf8'))
    assert.equal(previous.findings[0].triageStatus, 'needs-review')
  }
  const saved = await readFile(triagePath)
  const retry = await fixture.deliver('{"findings":{"stale":{"triageStatus":"fixed"}}}')
  assert.equal(retry.status, 1)
  assert.match(retry.stderr, /unknown finding ID/)
  assert.deepEqual(await readFile(triagePath), saved)
})

test('a manual decision must match exactly one original finding ID', async t => {
  const duplicate = await createRun(t, [{ id: 'F1' }, { id: 'F1' }])
  const ambiguous = await duplicate.deliver('{"findings":{"F1":{"triageStatus":"fixed"}}}')
  assert.equal(ambiguous.status, 1)
  assert.match(ambiguous.stderr, /matches multiple findings/)
  assert.equal(existsSync(duplicate.delivery), false)

  const missing = await createRun(t, [{}, { id: 'unknown' }])
  const result = await missing.deliver('{"findings":{"unknown":{"triageStatus":"fixed"}}}')
  assert.equal(result.status, 0, result.stderr)
  const triage = JSON.parse(await readFile(join(missing.delivery, 'triage.json'), 'utf8'))
  assert.deepEqual(triage.findings.map(item => item.triageStatus), ['needs-review', 'fixed'])
})
