import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(root, 'scripts', 'redscope-fix-brief.mjs')

function result(id, severity = 'high') {
  return {
    category: 'static-analysis', id, severity, title: 'Semgrep finding: untrusted-field',
    target: 'src/𠮷野.ts:12',
    evidence: [{ id: 'EV-001', path: 'omitted-raw-path', description: 'omitted-evidence-body' }],
    description: 'omitted-description', remediation: 'omitted-free-text',
    testProcess: ['omitted-process'], validation: { snippet: 'omitted-code' },
  }
}

async function fixture(t, findings) {
  const run = await mkdtemp(join(root, '.fix-brief-test-'))
  t.after(() => rm(run, { recursive: true, force: true }))
  await writeFile(join(run, 'findings.json'), JSON.stringify({ schemaVersion: 1, findings }))
  return run
}

function invoke(run, ...args) {
  const proc = spawnSync(process.execPath, [cli, '--run', run, ...args], {
    cwd: run, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
  })
  if (proc.error) throw proc.error
  return proc
}

function success(run, ...args) {
  const proc = invoke(run, ...args)
  assert.equal(proc.status, 0, proc.stderr)
  return { brief: JSON.parse(proc.stdout), chars: [...proc.stdout].length }
}

test('exports only static-analysis metadata, with a separate remediation reply contract', async t => {
  const run = await fixture(t, [
    result('F-01', 'medium'), { ...result('omitted-network-record'), category: 'other' },
    { ...result('F-02', 'critical'), ruleId: 'js/incomplete-validation' }, result('F-03', 'medium'),
  ])
  const { brief } = success(run)
  assert.equal(brief.kind, 'redscope-fix-brief')
  assert.equal(brief.schemaVersion, 1)
  assert.match(brief.briefId, /^[a-f0-9]{16}$/)
  assert.equal(brief.responseFormat.briefId, brief.briefId)
  assert.deepEqual(brief.findings.map(f => f.findingId), ['F-02', 'F-01', 'F-03'])
  assert.deepEqual(brief.findings[0], {
    findingId: 'F-02', severity: 'critical', ruleId: 'js/incomplete-validation', title: 'Semgrep finding: untrusted-field',
    location: 'src/𠮷野.ts:12', evidenceIds: ['EV-001'], evidenceRefsOmitted: 0,
  })
  assert.deepEqual(brief.pagination, { total: 3, offset: 0, returned: 3, omitted: 0, nextOffset: null })
  assert.deepEqual(Object.keys(brief.responseFormat.repairs[0]), ['findingId', 'proposedChange', 'acceptanceCheck'])
  assert.deepEqual(Object.keys(brief.responseFormat.needsContext[0]), ['findingId', 'missingContext'])
  assert.doesNotMatch(JSON.stringify(brief), /omitted-/)
})

test('respects an exact Unicode code-point budget including the newline', async t => {
  const run = await fixture(t, [result('A'), result('B'), result('C'), result('D')])
  const { chars, brief } = success(run)
  assert.ok(chars > 1024)
  assert.deepEqual(success(run, '--max-chars', String(chars)).brief, brief)
  const page = success(run, '--max-chars', String(chars - 1))
  assert.ok(page.chars <= chars - 1)
  assert.notEqual(page.brief.briefId, brief.briefId)
  assert.deepEqual(page.brief.pagination, { total: 4, offset: 0, returned: 3, omitted: 1, nextOffset: 3 })
})

test('binds the page ID to the original report bytes and current offset', async t => {
  const run = await fixture(t, [result('A'), result('B')])
  const path = join(run, 'findings.json')
  const { brief } = success(run)
  assert.notEqual(success(run, '--offset', '1').brief.briefId, brief.briefId)
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')]))
  const next = success(run).brief
  assert.deepEqual(next.findings, brief.findings)
  assert.notEqual(next.briefId, brief.briefId)
  assert.equal(next.responseFormat.briefId, next.briefId)
})

test('follows offsets to the end with stable ordering and accurate counts', async t => {
  const findings = Array.from({ length: 100 }, (_, i) => result('ID-' + i, i % 2 ? 'low' : 'medium'))
  const run = await fixture(t, findings)
  let offset = 0
  const found = []
  do {
    const { brief, chars } = success(run, '--offset', String(offset))
    assert.ok(chars <= 8000)
    const { pagination } = brief
    assert.equal(pagination.total, findings.length)
    assert.equal(pagination.returned, brief.findings.length)
    assert.equal(pagination.omitted, findings.length - pagination.returned)
    assert.equal(pagination.offset, found.length)
    found.push(...brief.findings.map(f => f.findingId))
    offset = pagination.nextOffset
    if (offset !== null) assert.equal(offset, found.length)
  } while (offset !== null)
  const ordered = ['medium', 'low'].flatMap(s => findings.filter(f => f.severity === s).map(f => f.id))
  assert.deepEqual(found, ordered)
  assert.deepEqual(success(run, '--offset', String(found.length)).brief.findings, [])
})

test('clips labels at a Unicode boundary, counts omitted evidence and drops multiline data', async t => {
  const long = { ...result('A'), title: '𠮷'.repeat(130), target: 'src/a.ts\nsecret-line' }
  long.evidence = Array.from({ length: 12 }, (_, i) => ({ id: 'EV-' + i }))
  const run = await fixture(t, [long])
  const { brief } = success(run)
  assert.equal(brief.findings[0].title, '𠮷'.repeat(120) + '…')
  assert.equal(brief.findings[0].location, '')
  assert.equal(brief.findings[0].evidenceIds.length, 8)
  assert.equal(brief.findings[0].evidenceRefsOmitted, 4)
})

test('fails explicitly if one row cannot fit, or arguments are invalid', async t => {
  const finding = { ...result('ID-' + 'a'.repeat(120)), title: 't'.repeat(120), target: 'x'.repeat(200) }
  const run = await fixture(t, [finding])
  for (const args of [
    ['--max-chars', '1024'], ['--max-chars', 'invalid'], ['--offset', '2'], ['--offset', '-1'],
    ['--extra'], ['--offset', '0', '--offset', '0'], ['trailing'],
  ]) {
    const proc = invoke(run, ...args)
    assert.equal(proc.status, 1)
    assert.equal(proc.stdout, '')
    assert.match(proc.stderr, /redscope-fix-brief:/)
  }
})

test('rejects ambiguous static IDs, unrecognized schemas and malformed inputs', async t => {
  const run = await fixture(t, [result('F-1'), result('F-1')])
  assert.match(invoke(run).stderr, /unique/)
  await writeFile(join(run, 'findings.json'), '{"findings":[]}')
  assert.equal(invoke(run).status, 1)
  await writeFile(join(run, 'findings.json'), '{"omitted-sensitive-input"')
  const bad = invoke(run)
  assert.equal(bad.status, 1)
  assert.doesNotMatch(bad.stderr, /omitted-sensitive-input/)
})

test('returns an explicit empty page when the report contains no static findings', async t => {
  const run = await fixture(t, [{ ...result('N-1'), category: 'another-category' }])
  const { brief, chars } = success(run, '--max-chars', '1024')
  assert.ok(chars <= 1024)
  assert.deepEqual(brief.pagination, { total: 0, offset: 0, returned: 0, omitted: 0, nextOffset: null })
  assert.deepEqual(brief.findings, [])
})

test('writes exact UTF-8 to the requested new file and preserves existing content', async t => {
  const run = await fixture(t, [result('F-1')])
  const out = join(run, '修复交接.json')
  const expected = invoke(run).stdout
  const saved = invoke(run, '--out', out)
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(saved.stdout, '')
  assert.deepEqual(await readFile(out), Buffer.from(expected, 'utf8'))
  await writeFile(out, 'existing review')
  assert.equal(invoke(run, '--out', out).status, 1)
  assert.equal(await readFile(out, 'utf8'), 'existing review')
})

test('stores an optional trimmed review goal and preserves its internal text', async t => {
  const run = await fixture(t, [result('F-1')])
  assert.equal(Object.hasOwn(success(run).brief, 'reviewGoal'), false)
  const goal = '核对𠮷野的边界条件\n  Preserve  two spaces\tand a tab.'
  const { brief } = success(run, '--goal', ' \t' + goal + '\n　')
  assert.equal(brief.reviewGoal, goal)
  assert.equal(brief.responseFormat.briefId, brief.briefId)
  assert.equal(success(run, '--goal', goal).brief.briefId, brief.briefId)
  for (const blank of ['', '　 \r\n\t']) {
    const proc = invoke(run, '--goal', blank)
    assert.equal(proc.status, 1)
    assert.equal(proc.stdout, '')
    assert.match(proc.stderr, /redscope-fix-brief:/)
  }
})

test('counts the encoded Unicode goal in the exact output budget on full and empty pages', async t => {
  const goal = '𠮷'.repeat(400) + '\n"复核"'
  const run = await fixture(t, [result('A'), result('B')])
  const { chars, brief } = success(run, '--goal', goal)
  const exact = success(run, '--goal', goal, '--max-chars', String(chars))
  assert.deepEqual(exact.brief, brief)
  const smaller = success(run, '--goal', goal, '--max-chars', String(chars - 1))
  assert.ok(smaller.chars <= chars - 1)
  assert.equal(smaller.brief.reviewGoal, goal)
  assert.deepEqual(smaller.brief.findings.map(f => f.findingId), ['A'])
  assert.equal(smaller.brief.pagination.nextOffset, 1)

  const empty = await fixture(t, [])
  for (const [dir, offset] of [[empty, '0'], [run, '2']]) {
    const args = ['--goal', goal, '--offset', offset]
    const page = success(dir, ...args)
    assert.equal(page.brief.reviewGoal, goal)
    assert.deepEqual(page.brief.findings, [])
    assert.ok(page.chars - 1 >= 1024)
    assert.deepEqual(success(dir, ...args, '--max-chars', String(page.chars)).brief, page.brief)
    const tooSmall = invoke(dir, ...args, '--max-chars', String(page.chars - 1))
    assert.equal(tooSmall.status, 1)
    assert.equal(tooSmall.stdout, '')
    assert.match(tooSmall.stderr, /max-chars/)
  }
})

test('reply checker rejects a reply for the same finding under a different review goal', async t => {
  const run = await fixture(t, [result('F-1')])
  const goals = ['确认输入类型', '确认异常处理']
  const briefs = goals.map(goal => success(run, '--goal', goal).brief)
  assert.deepEqual(briefs[0].findings, briefs[1].findings)
  assert.deepEqual(briefs[0].pagination, briefs[1].pagination)
  assert.notEqual(briefs[0].briefId, briefs[1].briefId)
  const checker = join(root, 'scripts', 'redscope-check-fix-reply.mjs')
  for (const [i, brief] of briefs.entries()) {
    await writeFile(join(run, `brief-${i}.json`), JSON.stringify(brief))
    await writeFile(join(run, `reply-${i}.json`), JSON.stringify({
      briefId: brief.responseFormat.briefId,
      repairs: [],
      needsContext: [{ findingId: brief.findings[0].findingId, missingContext: 'Provide the input contract.' }],
    }))
  }
  for (const [brief, reply] of [[0, 0], [1, 1], [0, 1], [1, 0]]) {
    const proc = spawnSync(process.execPath, [checker, '--brief', `brief-${brief}.json`, '--reply', `reply-${reply}.json`], {
      cwd: run, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
    })
    assert.ifError(proc.error)
    const checked = JSON.parse(proc.stdout)
    const matches = brief === reply
    assert.equal(proc.status, matches ? 0 : 1, proc.stderr)
    assert.equal(checked.ok, matches)
    if (!matches) {
      assert.equal(checked.issues.length, 1)
      assert.match(checked.issues[0], /briefId/)
    }
  }
})
