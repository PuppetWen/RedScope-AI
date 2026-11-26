import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const verifier = join(repoRoot, 'scripts', 'redscope-verify-delivery.mjs')
const evidenceFile = 'raw/record.txt'
const evidenceBody = 'reviewed sample\n'
const reportBody = '# Delivery report\n'
const generatedAt = '2025-09-01T12:00:00.000Z'

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

// Construct the producer's v1 wire format independently of the verifier.
async function archive(t, { evidencePath } = {}) {
  const temp = await mkdtemp(join(repoRoot, '.verify-delivery-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const original = join(temp, 'original run')
  const moved = join(temp, 'archived delivery')
  const runDir = relative(repoRoot, original).split(sep).join('/')
  await mkdir(join(original, 'delivery'), { recursive: true })
  await mkdir(join(original, 'raw'))
  await writeFile(join(original, evidenceFile), evidenceBody)
  const evidence = {
    id: 'EV-001',
    kind: 'raw-output',
    path: runDir + '/' + (evidencePath ?? evidenceFile),
    description: 'Recorded sample',
    sha256: sha256(evidenceBody),
    bytes: Buffer.byteLength(evidenceBody),
  }
  const index = JSON.stringify({ schemaVersion: 1, generatedAt, runDir, evidence: [evidence], notes: [] })
  const files = [
    ['run.json', 'run-manifest', '{}\n'],
    ['findings.json', 'findings', '{"findings":[]}\n'],
    ['evidence-index.json', 'evidence-index', index],
    ['report.md', 'markdown-report', reportBody],
    ['delivery/triage.json', 'triage', '{}\n'],
    ['delivery/reviewer-notes.md', 'reviewer-notes', 'Review complete.\n'],
  ]
  const signedFiles = []
  for (const [name, role, content] of files) {
    await writeFile(join(original, name), content)
    signedFiles.push({ path: runDir + '/' + name, role, sha256: sha256(content), bytes: Buffer.byteLength(content) })
  }
  const canonical = [...signedFiles].sort((a, b) => a.path.localeCompare(b.path))
  const bundleDigest = sha256(JSON.stringify(canonical))
  const signature = {
    schemaVersion: 1, generatedAt, runDir, algorithm: 'sha256', signatureKind: 'local-integrity-manifest',
    reviewer: 'Reviewer', deliveryStatus: 'ready-for-review', signedFiles, bundleDigest, notes: [],
  }
  await writeFile(join(original, 'delivery/report-signature.json'), JSON.stringify(signature))
  await rename(original, moved)
  return { moved, temp, bundleDigest }
}

function verify(run, expected, digest) {
  const args = [verifier, '--run', run, '--json']
  if (digest) args.push('--expect-digest', digest)
  const result = spawnSync(process.execPath, args, {
    cwd: dirname(run),
    encoding: 'utf8',
    env: { ...process.env, TMP: dirname(run), TEMP: dirname(run), TMPDIR: dirname(run) },
    timeout: 15000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, expected ? 0 : 1, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, expected)
  assert.ok(Array.isArray(report.issues))
  assert.equal(report.issues.length === 0, expected)
}

test('verifies a moved v1 delivery using its original manifest paths and a trusted digest', async t => {
  const { moved, bundleDigest } = await archive(t)
  verify(moved, true, bundleDigest)
})

test('detects an equal-length change to a signed report', async t => {
  const { moved } = await archive(t)
  await writeFile(join(moved, 'report.md'), reportBody.replace('Delivery', 'Modified'))
  verify(moved, false)
})

test('detects an equal-length change to evidence covered only by the signed index', async t => {
  const { moved } = await archive(t)
  await writeFile(join(moved, evidenceFile), evidenceBody.replace('reviewed', 'modified'))
  verify(moved, false)
})

test('returns a JSON failure when a signed file is missing', async t => {
  const { moved } = await archive(t)
  await rm(join(moved, 'delivery/reviewer-notes.md'))
  verify(moved, false)
})

test('rejects a signed index that points to a matching file outside the archive', async t => {
  const { moved, temp } = await archive(t, { evidencePath: '../outside.txt' })
  await writeFile(join(temp, 'outside.txt'), evidenceBody)
  verify(moved, false)
})

test('rejects an evidence directory redirected outside the archive', async t => {
  const { moved, temp } = await archive(t)
  const relocated = join(temp, 'relocated evidence')
  await rename(join(moved, 'raw'), relocated)
  await symlink(relocated, join(moved, 'raw'), process.platform === 'win32' ? 'junction' : 'dir')
  verify(moved, false)
})

test('returns a JSON failure for a malformed manifest', async t => {
  const { moved } = await archive(t)
  await writeFile(join(moved, 'delivery/report-signature.json'), '{')
  verify(moved, false)
})

test('rejects an internally consistent delivery with a different externally expected digest', async t => {
  const { moved } = await archive(t)
  verify(moved, false, sha256('different archived delivery'))
})
