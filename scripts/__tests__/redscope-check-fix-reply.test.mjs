import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const script = join(repoRoot, 'scripts', 'redscope-check-fix-reply.mjs')
const brief = {
  briefId: '5518a8d650339d9f',
  kind: 'redscope-fix-brief',
  schemaVersion: 1,
  findings: [{ findingId: 'F-1' }, { findingId: 'F-2' }],
}
const repair = { findingId: 'F-1', proposedChange: 'Check the input.', acceptanceCheck: 'Run the unit test.' }
const context = { findingId: 'F-2', missingContext: 'Supply the expected input type.' }
const reply = { briefId: brief.briefId, repairs: [repair], needsContext: [context] }

async function fixture(t) {
  const dir = await mkdtemp(join(repoRoot, 'tools', 'tmp-check-fix-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const briefFile = join(dir, 'brief.json')
  const replyFile = join(dir, 'reply.json')
  return async (replyText, briefData = brief) => {
    await writeFile(briefFile, '\uFEFF' + JSON.stringify(briefData))
    await writeFile(replyFile, replyText)
    const child = spawnSync(process.execPath, [script, '--brief', briefFile, '--reply', replyFile], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir },
    })
    assert.ifError(child.error)
    assert.equal(child.stderr, '')
    const result = JSON.parse(child.stdout)
    assert.equal(result.ok, result.issues.length === 0)
    assert.equal(child.status, result.ok ? 0 : 1)
    return result
  }
}

test('checks plain JSON and a single copied JSON code block, including BOM and CRLF', async t => {
  const run = await fixture(t)
  assert.deepEqual(await run(JSON.stringify(reply)), { ok: true, issues: [] })
  const fenced = ['\uFEFF```json', JSON.stringify(reply), '```'].join('\r\n')
  assert.equal((await run(fenced)).ok, true)
  assert.equal((await run(JSON.stringify({ briefId: brief.briefId, repairs: [], needsContext: [] }), { ...brief, findings: [] })).ok, true)
})

test('requires every page ID exactly once across both arrays and reports locations', async t => {
  const run = await fixture(t)
  const { issues } = await run(JSON.stringify({
    briefId: brief.briefId,
    repairs: [repair, { ...repair, findingId: 'PRIVATE-UNKNOWN-ID' }],
    needsContext: [{ ...context, findingId: repair.findingId }],
  }))
  assert.match(issues.join('\n'), /repairs\[1\]\.findingId is outside/)
  assert.match(issues.join('\n'), /needsContext\[0\]\.findingId was used more than once/)
  assert.match(issues.join('\n'), /Missing reply for brief\.findings\[1\]/)
  assert.doesNotMatch(issues.join('\n'), /PRIVATE/)
})

test('rejects unknown keys, absent groups, empty text, invalid JSON and ambiguous briefs', async t => {
  const run = await fixture(t)
  const rejected = [
    { repairs: [repair], needsContext: [context] },
    { ...reply, briefId: 'eeeeeeeeeeeeeeee' },
    { ...reply, 'PRIVATE-ROOT': true },
    { repairs: [repair] },
    { ...reply, repairs: [{ ...repair, 'PRIVATE-FIELD': 1 }] },
    { ...reply, repairs: [{ ...repair, proposedChange: '   ' }] },
    { ...reply, repairs: [{ ...repair, acceptanceCheck: 123 }] },
    { ...reply, needsContext: [{ ...context, missingContext: null }] },
    { ...reply, repairs: [null] },
    [],
  ]
  const json = JSON.stringify(reply)
  const fenced = '```json\n' + json + '\n```'
  for (const text of [...rejected.map(value => JSON.stringify(value)), 'PRIVATE invalid JSON', fenced + '\n' + fenced, json + ' extra']) {
    const result = await run(text)
    assert.equal(result.ok, false)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  }
  assert.equal((await run(json, { ...brief, findings: [brief.findings[0], brief.findings[0]] })).ok, false)
  assert.equal((await run(json, { ...brief, schemaVersion: 2 })).ok, false)
  assert.equal((await run(json, { ...brief, briefId: 'not-a-page-id' })).ok, false)
})
