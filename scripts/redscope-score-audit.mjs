#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const usage = 'node scripts/redscope-score-audit.mjs --run <directory> --labels <file>'

function nonemptyText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)
}

function localLineTarget(value) {
  if (!nonemptyText(value)) return false
  const match = /^(.+):([1-9]\d*)$/.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) return false
  const file = match[1]
  return file.trim().length > 0 && file !== 'unknown file' &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(file) || /^(?:file:|[a-z]:[\\/])/i.test(file))
}

function locationKey(sourceTool, ruleId, target) {
  if (!nonemptyText(sourceTool) || !nonemptyText(ruleId) || !localLineTarget(target)) return null
  return JSON.stringify([sourceTool, ruleId, target])
}

function reportedRule(finding) {
  if (Object.hasOwn(finding, 'ruleId')) return finding.ruleId
  if (finding.sourceTool !== 'semgrep' || typeof finding.title !== 'string') return
  const match = /^Semgrep finding: (.+)$/.exec(finding.title)
  if (match && match[1] !== 'semgrep-rule') return match[1]
}

function score(bundle, labels) {
  if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.findings)) {
    throw new Error('Expected v1 findings.json with a findings array.')
  }
  if (!Array.isArray(labels?.cases)) throw new Error('Expected a labels file with a cases array.')
  const cases = new Map()
  for (const [index, item] of labels.cases.entries()) {
    const key = locationKey(item?.sourceTool, item?.ruleId, item?.target)
    if (!key || typeof item?.expected !== 'boolean') throw new Error(`Invalid label at cases[${index}].`)
    if (cases.has(key)) throw new Error(`Duplicate or conflicting label at cases[${index}].`)
    cases.set(key, item)
  }

  const reported = new Set()
  const unlabeledTargets = new Set()
  let unlabeledMatches = 0
  const unscorable = []
  let duplicateFindings = 0
  for (const [index, finding] of bundle.findings.entries()) {
    if (!nonemptyText(finding?.category)) throw new Error(`Invalid category at findings[${index}].`)
    if (finding.category !== 'static-analysis') continue
    const ruleId = reportedRule(finding)
    const key = locationKey(finding.sourceTool, ruleId, finding.target)
    if (!key) {
      const fields = []
      if (!nonemptyText(finding.sourceTool)) fields.push('sourceTool')
      if (!nonemptyText(ruleId)) fields.push('ruleId')
      if (!localLineTarget(finding.target)) fields.push('target')
      unscorable.push({ index, invalidFields: fields })
    } else if (reported.has(key)) {
      duplicateFindings++
    } else {
      reported.add(key)
      if (!cases.has(key)) {
        unlabeledMatches++
        unlabeledTargets.add(finding.target)
      }
    }
  }

  const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 }
  const falsePositives = []
  const falseNegatives = []
  for (const [key, { sourceTool, ruleId, target, expected }] of cases) {
    const hit = reported.has(key)
    if (expected && hit) confusion.tp++
    else if (!expected && !hit) confusion.tn++
    else if (hit) {
      confusion.fp++
      falsePositives.push({ sourceTool, ruleId, target })
    } else {
      confusion.fn++
      falseNegatives.push({ sourceTool, ruleId, target })
    }
  }
  const { tp, fp, fn } = confusion
  return {
    schemaVersion: 1,
    basis: 'labeled-static-analysis-cases',
    labeledCases: cases.size,
    confusion,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    unlabeledMatches,
    unlabeledLocations: unlabeledTargets.size,
    unscorableFindings: unscorable.length,
    unscorable,
    duplicateFindings,
    falsePositives,
    falseNegatives,
  }
}

async function readJson(path, name) {
  let text
  try {
    if (!(await stat(path)).isFile()) throw new Error()
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`Cannot read the ${name} file.`)
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(`Invalid JSON in the ${name} file.`)
  }
}

try {
  const { values } = parseArgs({ options: {
    run: { type: 'string' },
    labels: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    console.log(usage)
  } else {
    if (!values.run || !values.labels) throw new Error(usage)
    if ([values.run, values.labels].some(path => /^(?:[\\/]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(path))) {
      throw new Error('Specify local paths for the run and labels.')
    }
    const [bundle, labels] = await Promise.all([
      readJson(join(values.run, 'findings.json'), 'findings'),
      readJson(values.labels, 'labels'),
    ])
    console.log(JSON.stringify(score(bundle, labels), null, 2))
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
