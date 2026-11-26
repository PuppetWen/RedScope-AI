#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { bundleDigest, hashFile } from './redscope-file-integrity.mjs'

const sha256 = /^[a-f0-9]{64}$/
const requiredFiles = [
  'run.json', 'findings.json', 'evidence-index.json', 'report.md',
  'delivery/triage.json', 'delivery/reviewer-notes.md',
]

// v1 manifests store forward-slash paths relative to the original project.
// Resolve only the suffix below the recorded run, even for a relocated archive.
function safeRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) return false
  return value.split('/').every(part => {
    if (!part || part === '.' || part === '..') return false
    if (process.platform !== 'win32') return true
    return !/[\\:\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  })
}

function entryPath(entry, runPrefix) {
  if (!safeRelativePath(entry?.path) || !entry.path.startsWith(runPrefix)) {
    throw new Error('Invalid path outside the recorded run')
  }
  if (typeof entry.sha256 !== 'string' || !sha256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error('Invalid file digest or byte count')
  }
  return entry.path.slice(runPrefix.length)
}

async function localFile(root, name) {
  const path = await realpath(join(root, name))
  const suffix = relative(root, path)
  if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) {
    throw new Error('Path resolves outside the run')
  }
  if (!(await stat(path)).isFile()) throw new Error('Expected a regular file')
  return path
}

async function readJson(root, name) {
  const path = await localFile(root, name)
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
}

async function verify(run, expected, result) {
  const root = await realpath(run)
  const signature = await readJson(root, 'delivery/report-signature.json')
  if (signature?.schemaVersion !== 1 || signature.algorithm !== 'sha256' ||
      signature.signatureKind !== 'local-integrity-manifest' ||
      (!safeRelativePath(signature.runDir) && signature.runDir !== '.') ||
      !Array.isArray(signature.signedFiles)) {
    throw new Error('Invalid v1 delivery integrity manifest')
  }
  const prefix = signature.runDir === '.' ? '' : signature.runDir + '/'
  const files = signature.signedFiles
  const signed = new Map()
  for (const entry of files) {
    const name = entryPath(entry, prefix)
    if (typeof entry.role !== 'string' || !entry.role || signed.has(name)) {
      throw new Error('Invalid or duplicate signed file entry')
    }
    signed.set(name, entry)
  }
  for (const name of requiredFiles) {
    if (!signed.has(name)) throw new Error('Missing signed file entry: ' + name)
  }
  result.bundleDigest = bundleDigest(files)
  if (result.bundleDigest !== signature.bundleDigest) throw new Error('Bundle digest mismatch')
  if (expected !== undefined && expected.toLowerCase() !== result.bundleDigest) {
    throw new Error('Bundle differs from the expected digest')
  }

  // The signature and evidence index can cover the same large file.
  const hashes = new Map()
  let indexBytes
  async function check(entry, name) {
    try {
      let actual = hashes.get(name)
      if (!actual) {
        const path = await localFile(root, name)
        if (name === 'evidence-index.json') {
          // Parse the same bytes authenticated against the signature below.
          indexBytes = await readFile(path)
          actual = { sha256: createHash('sha256').update(indexBytes).digest('hex'), bytes: indexBytes.length }
        } else {
          actual = await hashFile(path)
        }
        hashes.set(name, actual)
      }
      if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
        throw new Error('File content or byte count differs')
      }
      return true
    } catch (error) {
      result.issues.push({ path: name, message: error.code === 'ENOENT' ? 'File missing' : error.message })
      return false
    }
  }

  let indexVerified = false
  for (const [name, entry] of signed) {
    if (await check(entry, name)) {
      result.verifiedFiles++
      if (name === 'evidence-index.json') indexVerified = true
    }
  }
  if (!indexVerified) return
  const index = JSON.parse(indexBytes.toString('utf8').replace(/^\uFEFF/, ''))
  if (index?.schemaVersion !== 1 || index.runDir !== signature.runDir || !Array.isArray(index.evidence)) {
    throw new Error('Invalid evidence-index.json for this run')
  }
  for (const entry of index.evidence) {
    const name = entryPath(entry, prefix)
    if (await check(entry, name)) result.verifiedEvidence++
  }
}

let values
try {
  values = parseArgs({
    options: {
      run: { type: 'string' },
      json: { type: 'boolean' },
      'expect-digest': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (values.help || !values.run) {
  console[values.help ? 'log' : 'error']('Usage: redscope-verify --run <run-directory> [--expect-digest <sha256>] [--json]')
  process.exit(values.help ? 0 : 2)
}
const result = { ok: false, verifiedFiles: 0, verifiedEvidence: 0, issues: [] }
try {
  await verify(values.run, values['expect-digest'], result)
} catch (error) {
  result.issues.push({ message: error.message })
}
result.ok = result.issues.length === 0
if (values.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log((result.ok ? 'Verified' : 'Verification failed') + ' — ' + result.verifiedFiles +
    ' signed files and ' + result.verifiedEvidence + ' indexed evidence entries verified.')
  for (const issue of result.issues) console.error(issue.path ? issue.path + ': ' + issue.message : issue.message)
}
process.exitCode = result.ok ? 0 : 1
