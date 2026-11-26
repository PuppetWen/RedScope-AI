#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'

const usage = 'node scripts/redscope-check-fix-reply.mjs --brief <file> --reply <file>'
const validId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const replyFields = {
  repairs: ['findingId', 'proposedChange', 'acceptanceCheck'],
  needsContext: ['findingId', 'missingContext'],
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseArgs(args) {
  const files = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const file = args[index + 1]
    if (!['--brief', '--reply'].includes(key) || files.has(key) || !file || file.startsWith('--')) {
      throw new Error(usage)
    }
    files.set(key, file)
  }
  if (files.size !== 2) throw new Error(usage)
  return files
}

async function readJson(file, role) {
  if (/^(?:[\\/]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(file)) {
    throw new Error(`${role} must be a local file.`)
  }
  let content
  try {
    if (!(await stat(file)).isFile()) throw new Error()
    content = (await readFile(file, 'utf8')).trim()
  } catch {
    throw new Error(`Cannot read the ${role} file.`)
  }
  if (role === 'reply' && content.startsWith('```')) {
    const fenced = /^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*)\r?\n```$/i.exec(content)
    if (!fenced) throw new Error('Expected one JSON code block in the reply.')
    content = fenced[1].trim()
  }
  try {
    return JSON.parse(content)
  } catch {
    // SyntaxError can quote input containing private source or model output.
    throw new Error(`Invalid JSON in the ${role} file.`)
  }
}

function briefFindingIds(brief) {
  if (!isObject(brief) || brief.schemaVersion !== 1 || brief.kind !== 'redscope-fix-brief' || !Array.isArray(brief.findings)) {
    throw new Error('Expected a version 1 redscope-fix-brief with a findings array.')
  }
  if (typeof brief.briefId !== 'string' || !/^[0-9a-f]{16}$/.test(brief.briefId)) {
    throw new Error('Expected a 16-character lowercase hexadecimal briefId in the brief.')
  }
  const ids = new Map()
  brief.findings.forEach((finding, index) => {
    const id = finding?.findingId
    if (typeof id !== 'string' || !validId.test(id) || ids.has(id)) {
      throw new Error(`Invalid or repeated findingId at brief.findings[${index}].`)
    }
    ids.set(id, index)
  })
  return ids
}

function validateReply(reply, ids, briefId) {
  if (!isObject(reply)) return ['Expected a JSON object in the reply.']
  const issues = []
  if (reply.briefId !== briefId) issues.push('Reply briefId does not match this page.')
  if (Object.keys(reply).some(key => key !== 'briefId' && !Object.hasOwn(replyFields, key))) {
    issues.push('Unexpected field at the root of the reply.')
  }

  const seen = new Set()
  for (const [group, fields] of Object.entries(replyFields)) {
    if (!Array.isArray(reply[group])) {
      issues.push(`${group} must be an array.`)
      continue
    }
    reply[group].forEach((item, index) => {
      const path = `${group}[${index}]`
      if (!isObject(item)) {
        issues.push(`${path} must be an object.`)
        return
      }
      if (Object.keys(item).some(key => !fields.includes(key))) {
        issues.push(`Unexpected field at ${path}.`)
      }
      for (const field of fields) {
        if (typeof item[field] !== 'string' || !item[field].trim()) {
          issues.push(`${path}.${field} must be a non-empty string.`)
        }
      }
      const id = item.findingId
      if (typeof id !== 'string' || !id.trim()) return
      if (!ids.has(id)) issues.push(`${path}.findingId is outside this brief.`)
      else if (seen.has(id)) issues.push(`${path}.findingId was used more than once.`)
      else seen.add(id)
    })
  }
  for (const [id, index] of ids) {
    if (!seen.has(id)) issues.push(`Missing reply for brief.findings[${index}].findingId.`)
  }
  return issues
}

async function check(args) {
  const files = parseArgs(args)
  const brief = await readJson(files.get('--brief'), 'brief')
  const ids = briefFindingIds(brief)
  const reply = await readJson(files.get('--reply'), 'reply')
  return validateReply(reply, ids, brief.briefId)
}

if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(usage)
} else {
  const issues = await check(process.argv.slice(2)).catch(error => [error.message])
  console.log(JSON.stringify({ ok: issues.length === 0, issues }))
  process.exitCode = issues.length === 0 ? 0 : 1
}
