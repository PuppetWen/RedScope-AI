#!/usr/bin/env bun
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { envPathFrom } from './redscope-env-config.ts'

type Options = {
  runPath?: string
  latest: boolean
  profileId?: string
  scopePath?: string
  routesPath?: string
  roleMatrixPath?: string
  workflowMapPath?: string
  outputRoot: string
  outputDir?: string
  dryRun: boolean
  json: boolean
}

type DraftFileResult = {
  kind: string
  path?: string
  draftCount: number
  skippedCount: number
  dryRun?: boolean
  preview?: unknown
}

type DraftResult = {
  schemaVersion: 1
  generatedAt: string
  status: 'completed' | 'skipped'
  outputDir: string
  files: DraftFileResult[]
  policy: {
    modifiesScope: false
    executesNetworkRequests: false
    approvalRequiredBeforeUse: true
    storesRawSecrets: false
    notes: string[]
  }
}

type LowImpactValidatorDraft = {
  validator: Record<string, unknown>
  sourceCandidate: Record<string, unknown>
  fieldsNeedingAnalystReview: string[]
  approvalRequired: true
  copyInto: 'validation.validators'
}

type LowImpactDraftBundle = {
  schemaVersion: 1
  generatedAt: string
  draftType: 'validation.validators'
  source: {
    runDir: string
    pocValidationPlan?: string
    validationEvidenceGates?: string
  }
  target?: string
  draftCount: number
  skippedCount: number
  drafts: LowImpactValidatorDraft[]
  skippedCandidates: Array<{
    sourceId?: string
    sourcePath?: string
    status?: string
    reason: string
  }>
  approvalRequired: true
  notes: string[]
}

type LogicTestCaseDraft = {
  testCase: Record<string, unknown>
  source: Record<string, unknown>
  fieldsNeedingAnalystReview: string[]
  approvalRequired: true
  copyInto: 'logicValidation.testCases'
}

type LogicDraftBundle = {
  schemaVersion: 1
  generatedAt: string
  draftType: 'logicValidation.testCases'
  source: {
    scopePath?: string
    routesPath?: string
    roleMatrixPath?: string
    workflowMapPath?: string
  }
  actorSessionDrafts: Array<Record<string, unknown>>
  draftCount: number
  skippedCount: number
  drafts: LogicTestCaseDraft[]
  skippedRoutes: Array<{
    routeId?: string
    path?: string
    method?: string
    reason: string
  }>
  approvalRequired: true
  notes: string[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
  'tools/outputs',
)
const defaultDraftRoot = envPathFrom(
  ['REDSCOPE_TOOLS_DRAFT_ROOT', 'REDSCOPE_DRAFT_ROOT'],
  'tools/drafts',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-draft-generator.ts --run <run-dir> [options]
  bun run scripts/redscope-draft-generator.ts --latest --profile authorized-poc-candidate-validation [options]
  bun run scripts/redscope-draft-generator.ts --routes <routes.json> --role-matrix <roles.json> [options]

Draft sources:
  --run <path>            PoC validation run directory for low-impact validator drafts
  --latest                Use latest run for --profile under --output-root
  --profile <id>          Profile id for --latest (default: authorized-poc-candidate-validation)
  --routes <path>         API route inventory JSON for business-logic drafts
  --role-matrix <path>    Owner-approved actor/role matrix JSON
  --workflow-map <path>   Optional workflow map JSON with route/step metadata
  --scope <path>          Optional scope file to avoid duplicate draft ids

Options:
  --output-root <path>    Run output root for --latest (default: ${defaultOutputRoot})
  --output-dir <path>     Draft output directory (default: run/drafts or ${defaultDraftRoot}/<timestamp>)
  --dry-run               Print drafts without writing files
  --json                  Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    latest: false,
    outputRoot: defaultOutputRoot,
    dryRun: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--latest') {
      options.latest = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()

    switch (arg) {
      case '--run':
        options.runPath = next
        break
      case '--profile':
        options.profileId = next
        break
      case '--scope':
        options.scopePath = next
        break
      case '--routes':
        options.routesPath = next
        break
      case '--role-matrix':
        options.roleMatrixPath = next
        break
      case '--workflow-map':
        options.workflowMapPath = next
        break
      case '--output-root':
        options.outputRoot = next
        break
      case '--output-dir':
        options.outputDir = next
        break
      default:
        usage()
    }
    index++
  }

  return options
}

function projectPath(path: string): string {
  const relativePath = relative(repoRoot, path).split(sep).join('/')
  return relativePath || '.'
}

function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)
}

function assertInside(child: string, parent: string, label: string) {
  const relation = relative(parent, child)
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
    return
  }
  throw new Error(`${label} must stay inside ${projectPath(parent)}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  return JSON.parse(raw) as T
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined
  return readJsonFile<T>(path)
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function recordValue(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return isRecord(child) ? child : undefined
}

function arrayValue(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return []
  const child = value[key]
  return Array.isArray(child) ? child : []
}

function stringValue(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'string' && child.trim() ? child.trim() : undefined
}

function booleanValue(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'boolean' ? child : undefined
}

function numberValue(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

function propertyStringList(value: unknown, key: string): string[] {
  if (!isRecord(value)) return []
  return stringList(value[key])
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function latestRunDir(outputRoot: string, profileId: string): Promise<string> {
  const profileRoot = resolve(outputRoot, profileId)
  assertInside(profileRoot, repoRoot, 'profile output root')
  if (!(await pathExists(profileRoot))) {
    throw new Error(`${projectPath(profileRoot)} does not exist`)
  }
  const candidates: Array<{ path: string; time: number }> = []
  for (const entry of await readdir(profileRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runDir = join(profileRoot, entry.name)
    const runPath = join(runDir, 'run.json')
    if (!(await pathExists(runPath))) continue
    const run = await readJsonIfExists<Record<string, unknown>>(runPath)
    const generatedAt = stringValue(run, 'generatedAt')
    const info = await stat(runDir)
    const time = Date.parse(generatedAt ?? '') || info.mtimeMs
    candidates.push({ path: runDir, time })
  }
  candidates.sort((a, b) => b.time - a.time)
  const latest = candidates[0]?.path
  if (!latest) throw new Error(`no runs found for ${profileId}`)
  return latest
}

async function resolveRunDir(options: Options): Promise<string | undefined> {
  if (options.runPath) {
    const runDir = resolveProjectPath(options.runPath)
    assertInside(runDir, repoRoot, 'run directory')
    return runDir
  }
  if (!options.latest) return undefined
  const outputRoot = resolveProjectPath(options.outputRoot)
  assertInside(outputRoot, repoRoot, 'output root')
  return latestRunDir(
    outputRoot,
    options.profileId ?? 'authorized-poc-candidate-validation',
  )
}

function defaultOutputDir(options: Options, runDir: string | undefined): string {
  if (options.outputDir) {
    const outputDir = resolveProjectPath(options.outputDir)
    assertInside(outputDir, repoRoot, 'output directory')
    return outputDir
  }
  if (runDir) return join(runDir, 'drafts')
  const draftRoot = resolveProjectPath(defaultDraftRoot)
  assertInside(draftRoot, repoRoot, 'draft root')
  return join(draftRoot, `${timestampId()}-scope-drafts`)
}

function targetPathFromTemplateSource(text: string): string | undefined {
  const match = text.match(/['"]?\{\{BaseURL\}\}([^'"\]\s]+)['"]?/i)
  if (!match?.[1]) return undefined
  const raw = match[1].trim()
  if (!raw.startsWith('/')) return '/'
  return raw.replace(/\{\{[^}]+\}\}/g, 'example')
}

function requestMethodFromTemplateSource(text: string): 'GET' | 'HEAD' | undefined {
  const method = text.match(/^\s*method\s*:\s*(GET|HEAD)\s*$/im)?.[1]
  return method === 'HEAD' ? 'HEAD' : method === 'GET' ? 'GET' : undefined
}

function statusFromTemplateSource(text: string): number | undefined {
  const match = text.match(/type\s*:\s*status[\s\S]{0,600}?status\s*:\s*(?:\[\s*)?([1-5][0-9]{2})/i)
  const value = match?.[1] ? Number(match[1]) : undefined
  return Number.isInteger(value) ? value : undefined
}

async function templateHint(sourcePath: string | undefined): Promise<{
  path?: string
  requestMethod?: 'GET' | 'HEAD'
  expectedStatus?: number
  readable: boolean
  warnings: string[]
}> {
  if (!sourcePath) {
    return { readable: false, warnings: ['candidate sourcePath is missing'] }
  }
  const resolved = resolveProjectPath(sourcePath)
  assertInside(resolved, repoRoot, 'candidate source path')
  if (!(await pathExists(resolved))) {
    return {
      readable: false,
      warnings: [`candidate source file ${projectPath(resolved)} was not found locally`],
    }
  }
  const info = await stat(resolved)
  const text = (await readFile(resolved)).subarray(0, Math.min(info.size, 128 * 1024)).toString('utf8')
  return {
    path: targetPathFromTemplateSource(text),
    requestMethod: requestMethodFromTemplateSource(text),
    expectedStatus: statusFromTemplateSource(text),
    readable: true,
    warnings: [],
  }
}

function lowImpactSeverity(value: string | undefined): 'info' | 'low' | 'medium' {
  if (value === 'info' || value === 'low' || value === 'medium') return value
  return 'low'
}

async function buildLowImpactDrafts(runDir: string): Promise<LowImpactDraftBundle> {
  const planPath = join(runDir, 'raw', 'poc-validation-plan.json')
  const gatesPath = join(runDir, 'raw', 'validation-evidence-gates.json')
  const plan = await readJsonIfExists<Record<string, unknown>>(planPath)
  const gates = await readJsonIfExists<Record<string, unknown>>(gatesPath)
  if (!plan || !gates) {
    throw new Error(
      `${projectPath(runDir)} is missing raw/poc-validation-plan.json or raw/validation-evidence-gates.json`,
    )
  }

  const target = stringValue(plan, 'target')
  const candidates = arrayValue(gates, 'candidates').filter(isRecord)
  const drafts: LowImpactValidatorDraft[] = []
  const skippedCandidates: LowImpactDraftBundle['skippedCandidates'] = []

  for (const [index, candidate] of candidates.entries()) {
    const status = stringValue(candidate, 'status')
    const sourcePath = stringValue(candidate, 'sourcePath')
    const sourceId = stringValue(candidate, 'sourceId')
    if (status !== 'ready-for-approved-low-impact-validation') {
      skippedCandidates.push({
        sourceId,
        sourcePath,
        status,
        reason: 'candidate is not validation-ready',
      })
      continue
    }

    const review = recordValue(candidate, 'templateReview')
    const hint = await templateHint(sourcePath)
    const matchedCves = propertyStringList(candidate, 'matchedCves').map(item =>
      item.toUpperCase(),
    )
    const matchedProducts = propertyStringList(candidate, 'matchedProducts')
    const matchedVersions = propertyStringList(candidate, 'matchedVersions')
    const matchedCpes = propertyStringList(candidate, 'matchedCpe23Names')
    const templateId = stringValue(review, 'templateId')
    const expectedStatus = hint.expectedStatus ?? 200
    const fieldsNeedingAnalystReview = [
      'approval.approvedBy',
      'approval.approvalReference',
      'path',
      'method',
      'expectedStatus/header/expected assertion',
      'impact',
      'remediation',
    ]
    if (!hint.path) fieldsNeedingAnalystReview.push('template-derived path was unavailable')
    if (!hint.readable) fieldsNeedingAnalystReview.push('candidate source could not be read')

    const validator = {
      id: slug(
        [
          'draft',
          templateId ?? sourceId ?? `candidate-${index + 1}`,
          matchedCves[0] ?? matchedProducts[0] ?? 'low-impact',
        ].join('-'),
        `draft-low-impact-${index + 1}`,
      ),
      title: `Draft low-impact validation for ${matchedCves[0] ?? templateId ?? sourceId ?? `candidate ${index + 1}`}`,
      target,
      method: 'http-status',
      requestMethod: hint.requestMethod ?? 'HEAD',
      path: hint.path ?? '/',
      expectedStatus,
      severity: lowImpactSeverity(stringValue(review, 'severity')),
      category: 'candidate-low-impact-validation',
      impact:
        'DRAFT: An analyst must confirm the non-destructive target condition and expected impact before approval.',
      remediation:
        'DRAFT: Fill in owner-approved remediation guidance after confirming the validator assertion.',
      references: uniqueSorted(
        matchedCves.map(cve => `https://nvd.nist.gov/vuln/detail/${cve}`),
      ),
      candidateCves: matchedCves,
      cpe23Names: matchedCpes,
      notes: [
        'DRAFT ONLY: copy into scope.validation.validators only after separate approval.',
        'Generated from a validation-ready PoC/template candidate without executing PoC code.',
        `Candidate source: ${sourcePath ?? 'unknown'}.`,
        `Matched products: ${matchedProducts.join(', ') || 'none'}.`,
        `Matched versions: ${matchedVersions.join(', ') || 'none'}.`,
        ...hint.warnings,
      ],
    }

    drafts.push({
      validator,
      sourceCandidate: {
        sourceId,
        sourcePath,
        status,
        templateId,
        templateReviewStatus: stringValue(review, 'status'),
        gateScore: numberValue(candidate, 'gateScore'),
        confidence: stringValue(candidate, 'confidence'),
        matchedProducts,
        matchedVersions,
        matchedCves,
        matchedCpe23Names: matchedCpes,
      },
      fieldsNeedingAnalystReview: uniqueSorted(fieldsNeedingAnalystReview),
      approvalRequired: true,
      copyInto: 'validation.validators',
    })
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    draftType: 'validation.validators',
    source: {
      runDir: projectPath(runDir),
      pocValidationPlan: projectPath(planPath),
      validationEvidenceGates: projectPath(gatesPath),
    },
    target,
    draftCount: drafts.length,
    skippedCount: skippedCandidates.length,
    drafts,
    skippedCandidates,
    approvalRequired: true,
    notes: [
      'These are draft validator objects only. They are not inserted into scope.validation.validators automatically.',
      'Review the path, request method, expected assertion, impact, remediation, and separate approval metadata before use.',
      'No network requests or PoC code execution were performed while generating these drafts.',
    ],
  }
}

function collectRecordsFromKeys(root: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(root)) return root.filter(isRecord)
  if (!isRecord(root)) return []
  const records: Record<string, unknown>[] = []
  for (const key of keys) {
    records.push(...arrayValue(root, key).filter(isRecord))
  }
  return records
}

function collectRoutes(root: unknown): Record<string, unknown>[] {
  const routes = collectRecordsFromKeys(root, [
    'routes',
    'endpoints',
    'apiRoutes',
    'operations',
  ])
  if (routes.length > 0 || !isRecord(root)) return routes

  const workflows = arrayValue(root, 'workflows').filter(isRecord)
  const workflowRoutes: Record<string, unknown>[] = []
  for (const workflow of workflows) {
    const workflowId = stringValue(workflow, 'id')
    const workflowTitle = stringValue(workflow, 'title') ?? stringValue(workflow, 'name')
    const family = stringValue(workflow, 'family') ?? stringValue(workflow, 'category')
    for (const step of arrayValue(workflow, 'steps').filter(isRecord)) {
      workflowRoutes.push({
        ...step,
        workflowId,
        workflowTitle,
        isolatedTestFamily: stringValue(step, 'isolatedTestFamily') ?? family,
      })
    }
  }
  return workflowRoutes
}

function actorIds(roleMatrix: unknown): string[] {
  return collectRecordsFromKeys(roleMatrix, ['actors', 'roles', 'actorSessions'])
    .map(actor => stringValue(actor, 'id') ?? stringValue(actor, 'name'))
    .filter((item): item is string => Boolean(item))
}

function actorSessionDrafts(roleMatrix: unknown): Array<Record<string, unknown>> {
  return collectRecordsFromKeys(roleMatrix, ['actors', 'actorSessions']).map(
    actor => ({
      id: stringValue(actor, 'id') ?? stringValue(actor, 'name'),
      role: stringValue(actor, 'role') ?? stringValue(actor, 'type'),
      headerEnv: stringValue(actor, 'headerEnv'),
      headerName: stringValue(actor, 'headerName') ?? 'Authorization',
      notes: [
        'DRAFT ONLY: provide a site-specific headerEnv or login block before active testing.',
      ],
    }),
  )
}

function defaultActor(
  roleMatrix: unknown,
  keys: string[],
  fallbackMatchers: string[],
  fallbackIndex: number,
): string | undefined {
  for (const key of keys) {
    const value = stringValue(roleMatrix, key)
    if (value) return value
  }
  const ids = actorIds(roleMatrix)
  for (const matcher of fallbackMatchers) {
    const found = ids.find(id => id.toLowerCase().includes(matcher))
    if (found) return found
  }
  return ids[fallbackIndex]
}

function routeMethod(route: Record<string, unknown>): string {
  return (stringValue(route, 'method') ?? stringValue(route, 'requestMethod') ?? 'GET')
    .toUpperCase()
}

function routePath(route: Record<string, unknown>): string | undefined {
  return stringValue(route, 'path') ?? stringValue(route, 'urlPath') ?? stringValue(route, 'route')
}

function routeId(route: Record<string, unknown>, index: number): string {
  return slug(
    stringValue(route, 'id') ??
      stringValue(route, 'operationId') ??
      `${routeMethod(route)}-${routePath(route) ?? `route-${index + 1}`}`,
    `route-${index + 1}`,
  )
}

function inferBusinessCategory(route: Record<string, unknown>): string {
  const explicit = stringValue(route, 'category') ?? stringValue(route, 'family')
  if (explicit) return explicit
  const path = (routePath(route) ?? '').toLowerCase()
  if (path.includes('payment')) return 'payment-flow'
  if (path.includes('refund')) return 'refund-flow'
  if (path.includes('coupon') || path.includes('promo')) return 'coupon-abuse'
  if (path.includes('upload') || path.includes('file')) return 'file-upload'
  if (path.includes('sql') || path.includes('query')) return 'sql-injection'
  if (path.includes('state') || path.includes('status')) return 'workflow-state'
  return 'idor'
}

function isStateChangingRoute(route: Record<string, unknown>): boolean {
  const method = routeMethod(route)
  return (
    booleanValue(route, 'stateChanging') === true ||
    booleanValue(route, 'mutating') === true ||
    !['GET', 'HEAD'].includes(method)
  )
}

function isOwnerScopedRoute(route: Record<string, unknown>): boolean {
  const path = routePath(route) ?? ''
  return (
    booleanValue(route, 'ownerScoped') === true ||
    booleanValue(route, 'objectScoped') === true ||
    /\{[^}]*id[^}]*\}|:[A-Za-z0-9_]*id\b/i.test(path)
  )
}

function sampleObject(roleMatrix: unknown, route: Record<string, unknown>): string {
  return (
    stringValue(route, 'sampleObject') ??
    stringValue(route, 'affectedObject') ??
    stringValue(roleMatrix, 'sampleObject') ??
    stringValue(roleMatrix, 'affectedObject') ??
    'owner-approved-object-id'
  )
}

function fillSamplePath(path: string, objectId: string): string {
  return path
    .replace(/\{[^}/]*(?:id|Id|ID)[^}/]*\}/g, objectId)
    .replace(/:[A-Za-z0-9_]*(?:id|Id|ID)\b/g, objectId)
}

function cweForCategory(category: string): string[] {
  if (category === 'idor') return ['CWE-639', 'CWE-862']
  if (category === 'vertical-authorization') return ['CWE-862', 'CWE-863']
  if (
    category === 'payment-flow' ||
    category === 'refund-flow' ||
    category === 'coupon-abuse' ||
    category === 'workflow-state'
  ) {
    return ['CWE-840']
  }
  if (category === 'file-upload') return ['CWE-434']
  if (category === 'sql-injection') return ['CWE-89']
  return ['CWE-862']
}

function explicitLogicTests(roleMatrix: unknown): Record<string, unknown>[] {
  return collectRecordsFromKeys(roleMatrix, [
    'authorizationTests',
    'businessLogicTests',
    'logicTests',
    'testCases',
  ])
}

function routeById(routes: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  routes.forEach((route, index) => {
    map.set(routeId(route, index), route)
    const explicit = stringValue(route, 'id') ?? stringValue(route, 'operationId')
    if (explicit) map.set(explicit, route)
  })
  return map
}

function existingLogicTestIds(scope: unknown): Set<string> {
  const tests = arrayValue(recordValue(scope, 'logicValidation'), 'testCases').filter(isRecord)
  return new Set(
    tests
      .map(test => stringValue(test, 'id'))
      .filter((item): item is string => Boolean(item)),
  )
}

function buildLogicDrafts(
  options: Options,
  scope: unknown,
  routesInput: unknown,
  roleMatrix: unknown,
  workflowMap: unknown,
): LogicDraftBundle {
  const routes = [
    ...collectRoutes(routesInput),
    ...collectRoutes(workflowMap),
  ]
  const byId = routeById(routes)
  const explicitTests = explicitLogicTests(roleMatrix)
  const explicitlyCoveredRouteIds = new Set(
    explicitTests
      .map(test => stringValue(test, 'routeId') ?? stringValue(test, 'operationId'))
      .filter((item): item is string => Boolean(item)),
  )
  const drafts: LogicTestCaseDraft[] = []
  const skippedRoutes: LogicDraftBundle['skippedRoutes'] = []
  const existingIds = existingLogicTestIds(scope)
  const controlActor = defaultActor(
    roleMatrix,
    ['controlActor', 'ownerActor'],
    ['owner', 'customer'],
    0,
  )
  const testActor = defaultActor(
    roleMatrix,
    ['testActor', 'otherActor'],
    ['other', 'attacker', 'non-owner'],
    1,
  )

  function pushDraft(
    rawRoute: Record<string, unknown>,
    index: number,
    source: Record<string, unknown>,
    explicit?: Record<string, unknown>,
  ) {
    const method = routeMethod(rawRoute)
    const rawPath = routePath(rawRoute)
    const idBase =
      stringValue(explicit, 'id') ??
      `${routeId(rawRoute, index)}-${isStateChangingRoute(rawRoute) ? 'evidence' : 'authorization'}`
    const id = slug(idBase, `logic-draft-${index + 1}`)
    if (existingIds.has(id)) {
      skippedRoutes.push({
        routeId: routeId(rawRoute, index),
        path: rawPath,
        method,
        reason: `scope already has logicValidation.testCases id ${id}`,
      })
      return
    }
    if (!rawPath) {
      skippedRoutes.push({
        routeId: routeId(rawRoute, index),
        method,
        reason: 'route path is missing',
      })
      return
    }

    const category = inferBusinessCategory(rawRoute)
    const objectId = sampleObject(roleMatrix, rawRoute)
    const path = fillSamplePath(rawPath, objectId)
    const stateChanging = isStateChangingRoute(rawRoute)
    const fields = [
      'logicValidation.approvedBy',
      'logicValidation.approvalReference',
      'path',
      'affectedObject',
      'expected statuses/outcome',
      'impact',
      'remediation',
    ]
    const common = {
      id,
      title:
        stringValue(explicit, 'title') ??
        stringValue(rawRoute, 'title') ??
        stringValue(rawRoute, 'name') ??
        `${method} ${path}`,
      category,
      target: stringValue(rawRoute, 'target'),
      severity: stringValue(rawRoute, 'severity') ?? (stateChanging ? 'high' : 'medium'),
      cweIds: cweForCategory(category),
      impact:
        stringValue(rawRoute, 'impact') ??
        'DRAFT: describe the owner-approved business impact before promotion.',
      remediation:
        stringValue(rawRoute, 'remediation') ??
        'DRAFT: describe the server-side authorization, ownership, and workflow control fix.',
      parallelGroup:
        stringValue(rawRoute, 'parallelGroup') ??
        stringValue(rawRoute, 'workflowId') ??
        (stateChanging ? category : 'authorization-readonly'),
      isolatedTestFamily:
        stringValue(rawRoute, 'isolatedTestFamily') ?? category,
      notes: [
        'DRAFT ONLY: review and approve before copying into logicValidation.testCases.',
        `Generated from route ${method} ${rawPath}.`,
      ],
    }

    const testCase = stateChanging
      ? {
          ...common,
          validationMode: 'evidence-only',
          path,
          method,
          expectedOutcome:
            stringValue(explicit, 'expectedOutcome') ??
            stringValue(rawRoute, 'expectedOutcome') ??
            'DRAFT: state-changing workflow requires owner-approved evidence or a separately reviewed runner.',
          observedImpact: false,
          evidenceRefs: [],
        }
      : {
          ...common,
          validationMode:
            method === 'GET' || method === 'HEAD'
              ? 'safe-readonly-http'
              : 'manual-review',
          path,
          method: method === 'HEAD' ? 'HEAD' : 'GET',
          controlActor:
            stringValue(explicit, 'controlActor') ??
            stringValue(rawRoute, 'controlActor') ??
            controlActor,
          testActor:
            stringValue(explicit, 'testActor') ??
            stringValue(rawRoute, 'testActor') ??
            testActor,
          objectOwnerActor:
            stringValue(explicit, 'objectOwnerActor') ??
            stringValue(rawRoute, 'objectOwnerActor') ??
            controlActor,
          affectedObject: objectId,
          expectedControlStatuses: [200],
          expectedDeniedStatuses: [401, 403, 404],
          vulnerableStatuses: [200],
        }

    if (!stateChanging && (!controlActor || !testActor)) {
      fields.push('controlActor/testActor actor matrix')
    }
    if (!stateChanging && !isOwnerScopedRoute(rawRoute)) {
      fields.push('confirm this route is object/owner scoped')
    }

    drafts.push({
      testCase,
      source,
      fieldsNeedingAnalystReview: uniqueSorted(fields),
      approvalRequired: true,
      copyInto: 'logicValidation.testCases',
    })
  }

  explicitTests.forEach((test, index) => {
    const routeRef = stringValue(test, 'routeId') ?? stringValue(test, 'operationId')
    const route = routeRef ? byId.get(routeRef) : undefined
    pushDraft(route ?? test, index, { sourceType: 'role-matrix-test', routeRef }, test)
  })

  routes.forEach((route, index) => {
    const id = routeId(route, index)
    const explicit = stringValue(route, 'id') ?? stringValue(route, 'operationId')
    if (explicitlyCoveredRouteIds.has(id) || (explicit && explicitlyCoveredRouteIds.has(explicit))) {
      skippedRoutes.push({
        routeId: id,
        path: routePath(route),
        method: routeMethod(route),
        reason: 'route is already covered by an explicit role-matrix test',
      })
      return
    }
    const shouldDraft =
      booleanValue(route, 'draftLogicTest') === true ||
      isStateChangingRoute(route) ||
      isOwnerScopedRoute(route)
    if (!shouldDraft) {
      skippedRoutes.push({
        routeId: routeId(route, index),
        path: routePath(route),
        method: routeMethod(route),
        reason: 'route is neither state-changing nor owner-scoped',
      })
      return
    }
    pushDraft(route, explicitTests.length + index, { sourceType: 'route-inventory' })
  })

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    draftType: 'logicValidation.testCases',
    source: {
      scopePath: options.scopePath,
      routesPath: options.routesPath,
      roleMatrixPath: options.roleMatrixPath,
      workflowMapPath: options.workflowMapPath,
    },
    actorSessionDrafts: actorSessionDrafts(roleMatrix),
    draftCount: drafts.length,
    skippedCount: skippedRoutes.length,
    drafts,
    skippedRoutes,
    approvalRequired: true,
    notes: [
      'These are draft business-logic test cases only. They are not inserted into the scope file automatically.',
      'safe-readonly-http drafts still require approved actor sessions and object IDs before execution.',
      'evidence-only drafts do not execute state-changing actions and promote only after observedImpact=true plus approved evidence refs.',
    ],
  }
}

async function loadOptionalJson(path: string | undefined): Promise<unknown> {
  if (!path) return undefined
  const resolved = resolveProjectPath(path)
  assertInside(resolved, repoRoot, 'input JSON path')
  if (!(await pathExists(resolved))) {
    throw new Error(`${projectPath(resolved)} does not exist`)
  }
  return readJsonFile<unknown>(resolved)
}

async function main(options: Options) {
  const runDir = await resolveRunDir(options)
  const hasLogicInputs = Boolean(options.routesPath || options.workflowMapPath)
  if (!runDir && !hasLogicInputs) usage()

  const outputDir = defaultOutputDir(options, runDir)
  assertInside(outputDir, repoRoot, 'output directory')

  const files: DraftFileResult[] = []

  if (runDir) {
    const lowImpactDrafts = await buildLowImpactDrafts(runDir)
    const outputPath = join(outputDir, 'low-impact-validator-drafts.json')
    if (!options.dryRun) await writeJson(outputPath, lowImpactDrafts)
    files.push({
      kind: 'validation.validators',
      path: options.dryRun ? undefined : projectPath(outputPath),
      draftCount: lowImpactDrafts.draftCount,
      skippedCount: lowImpactDrafts.skippedCount,
      dryRun: options.dryRun,
      preview: options.dryRun ? lowImpactDrafts : undefined,
    })
  }

  if (hasLogicInputs) {
    const scope = await loadOptionalJson(options.scopePath)
    const routes = await loadOptionalJson(options.routesPath)
    const roleMatrix = (await loadOptionalJson(options.roleMatrixPath)) ?? {}
    const workflowMap = await loadOptionalJson(options.workflowMapPath)
    const logicDrafts = buildLogicDrafts(
      options,
      scope,
      routes,
      roleMatrix,
      workflowMap,
    )
    const outputPath = join(outputDir, 'business-logic-testcase-drafts.json')
    if (!options.dryRun) await writeJson(outputPath, logicDrafts)
    files.push({
      kind: 'logicValidation.testCases',
      path: options.dryRun ? undefined : projectPath(outputPath),
      draftCount: logicDrafts.draftCount,
      skippedCount: logicDrafts.skippedCount,
      dryRun: options.dryRun,
      preview: options.dryRun ? logicDrafts : undefined,
    })
  }

  const result: DraftResult = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: files.length > 0 ? 'completed' : 'skipped',
    outputDir: projectPath(outputDir),
    files,
    policy: {
      modifiesScope: false,
      executesNetworkRequests: false,
      approvalRequiredBeforeUse: true,
      storesRawSecrets: false,
      notes: [
        'Draft generation only reads existing local artifacts and user-supplied route/role JSON files.',
        'Drafts must be reviewed and copied into the scope file manually before any validator profile can execute them.',
        'No network requests, scanner execution, credential use, or scope mutation happens in this script.',
      ],
    },
  }

  if (!options.dryRun) {
    await writeJson(join(outputDir, 'draft-manifest.json'), result)
  }

  if (options.json || options.dryRun) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Generated RedScope draft artifacts in ${projectPath(outputDir)}`)
  for (const file of files) {
    console.log(`  ${file.kind}: ${file.draftCount} draft(s), ${file.skippedCount} skipped`)
    if (file.path) console.log(`    ${file.path}`)
  }
}

const options = parseArgs(process.argv.slice(2))

main(options).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          status: 'failed',
          generatedAt: new Date().toISOString(),
          reason: message,
        },
        null,
        2,
      ),
    )
  } else {
    console.error(`redscope-draft-generator: ${message}`)
  }
  process.exitCode = 1
})
