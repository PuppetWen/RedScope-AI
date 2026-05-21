#!/usr/bin/env bun
import { createHash } from 'node:crypto'
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

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
type Confidence = 'low' | 'medium' | 'high'
type FindingStatus = 'confirmed' | 'suspected' | 'informational'
type EvidenceClass =
  | 'public-intelligence-lead'
  | 'target-fingerprint-correlation'
  | 'owner-confirmed-target-version'
  | 'target-verified-issue'

type Options = {
  runPath?: string
  latest: boolean
  profileId?: string
  outputRoot: string
  dryRun: boolean
  json: boolean
}

type RunManifest = {
  schemaVersion?: number
  generatedAt?: string
  status?: string
  profile?: {
    id?: string
    name?: string
    riskLevel?: string
    reportTemplate?: string
  }
  authorization?: {
    scopePath?: string
    owner?: string
    authorizedBy?: string
    reference?: string | null
    validFrom?: string
    validTo?: string
  }
  target?: Record<string, unknown>
  effectiveRateLimits?: Record<string, unknown>
  stopConditions?: string[]
  files?: Record<string, string>
}

type CommandManifest = {
  stepId?: string
  tool?: string
  kind?: string
  argv?: string[]
  cwd?: string
  outputFiles?: string[]
  status?: string
  reason?: string
  exitCode?: number
}

type EvidenceItem = {
  id: string
  kind: 'manifest' | 'scope' | 'targets' | 'raw-output' | 'generated' | 'screenshot'
  path: string
  description: string
  sha256: string
  bytes: number
}

type EvidenceReference = {
  id: string
  path: string
  description: string
  jsonPointer?: string
  line?: number
}

type Finding = {
  id: string
  title: string
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  category: string
  evidenceClass?: EvidenceClass
  target: string
  sourceTool: string
  evidence: EvidenceReference[]
  description: string
  impact: string
  remediation: string
  references: string[]
  testProcess?: string[]
  screenshots?: EvidenceReference[]
  validation?: Record<string, unknown>
}

type FindingBundle = {
  schemaVersion: 1
  generatedAt: string
  source: {
    runDir: string
    runGeneratedAt?: string
    runStatus?: string
    profile: {
      id?: string
      name?: string
      riskLevel?: string
      reportTemplate?: string
    }
    target: string
    authorization: RunManifest['authorization']
  }
  summary: {
    total: number
    highestSeverity: Severity | 'none'
    bySeverity: Record<Severity, number>
    byStatus: Record<FindingStatus, number>
    byEvidenceClass: Record<EvidenceClass, number>
  }
  findings: Finding[]
  limitations: string[]
  warnings: string[]
}

type EvidenceIndex = {
  schemaVersion: 1
  generatedAt: string
  runDir: string
  evidence: EvidenceItem[]
  notes: string[]
}

type NormalizationContext = {
  runDir: string
  run: RunManifest
  commands: CommandManifest[]
  evidence: EvidenceItem[]
  warnings: string[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
  'tools/outputs',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-report-pipeline.ts --run <tools/outputs/profile/run-id> [options]
  bun run scripts/redscope-report-pipeline.ts --latest --profile <id> [options]

Options:
  --output-root <path>     Output root to search for --latest (default: ${defaultOutputRoot})
  --dry-run                Normalize and print the report bundle without writing files
  --json                   Print machine-readable JSON
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
      case '--output-root':
        options.outputRoot = next
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
  const relativePath = relative(parent, child)
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  ) {
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

async function writeText(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function walkFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(fullPath)))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function booleanValue(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function recordValue(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key]
  return isRecord(value) ? value : undefined
}

function arrayValue(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const value = record?.[key]
  return Array.isArray(value) ? value : []
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim())
    : []
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      result[key] = entry
    }
  }
  return result
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return 'none'
  return entries.map(([key, value]) => `${key}: ${value}`).join(', ')
}

function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0)
}

function lowerHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[key.toLowerCase()] = entry
  }
  return headers
}

function targetLabel(run: RunManifest): string {
  const target = run.target
  if (!target) return 'unknown'
  return (
    stringValue(target, 'normalizedUrl') ??
    stringValue(target, 'raw') ??
    stringValue(target, 'normalizedHost') ??
    stringValue(target, 'repositoryPath') ??
    stringValue(target, 'artifactPath') ??
    'unknown'
  )
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case 'info':
      return 0
    case 'low':
      return 1
    case 'medium':
      return 2
    case 'high':
      return 3
    case 'critical':
      return 4
  }
}

function severityFromNuclei(value: string | undefined): Severity {
  switch (value?.toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return 'info'
  }
}

function severityFromSemgrep(value: string | undefined): Severity {
  switch (value?.toUpperCase()) {
    case 'ERROR':
      return 'high'
    case 'WARNING':
      return 'medium'
    case 'INFO':
      return 'info'
    default:
      return 'low'
  }
}

function confidenceFromScore(score: number | undefined): Confidence {
  if (score != null && score >= 75) return 'high'
  if (score != null && score >= 45) return 'medium'
  return 'low'
}

function confidenceValue(value: string | undefined): Confidence | undefined {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  return undefined
}

function evidenceClassValue(value: string | undefined): EvidenceClass | undefined {
  if (
    value === 'public-intelligence-lead' ||
    value === 'target-fingerprint-correlation' ||
    value === 'owner-confirmed-target-version' ||
    value === 'target-verified-issue'
  ) {
    return value
  }
  return undefined
}

function strongestEvidenceClass(values: EvidenceClass[]): EvidenceClass | undefined {
  const rank: Record<EvidenceClass, number> = {
    'public-intelligence-lead': 1,
    'target-fingerprint-correlation': 2,
    'owner-confirmed-target-version': 3,
    'target-verified-issue': 4,
  }
  return values.sort((a, b) => rank[b] - rank[a])[0]
}

function profilePrefix(profileId: string | undefined): string {
  const source = profileId ?? 'run'
  const initials = source
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('')
  return (initials || 'RUN').slice(0, 6)
}

function findingFactory(profileId: string | undefined) {
  let count = 0
  const prefix = profilePrefix(profileId)
  return (finding: Omit<Finding, 'id'>): Finding => {
    count++
    return {
      id: `RS-${prefix}-${String(count).padStart(3, '0')}`,
      ...finding,
    }
  }
}

function evidenceLookup(
  evidence: EvidenceItem[],
  relativePath: string,
): EvidenceItem | undefined {
  return evidence.find(item => item.path === relativePath)
}

function evidenceRef(
  context: NormalizationContext,
  relativePath: string,
  description: string,
  jsonPointer?: string,
  line?: number,
): EvidenceReference {
  const item = evidenceLookup(context.evidence, relativePath)
  return {
    id: item?.id ?? 'EV-UNKNOWN',
    path: relativePath,
    description,
    jsonPointer,
    line,
  }
}

function screenshotEvidenceRefs(context: NormalizationContext): EvidenceReference[] {
  return context.evidence
    .filter(item => item.kind === 'screenshot')
    .map(item => ({
      id: item.id,
      path: item.path,
      description: item.description,
    }))
}

function defaultTestProcess(sourceTool: string): string[] {
  return [
    'Validated the target and authorization scope before creating report artifacts.',
    `Collected evidence through ${sourceTool}; command status was not recorded in this finding.`,
    'Normalized raw output into findings without copying raw secrets, payloads, or response bodies into the report.',
  ]
}

async function evidenceItem(
  id: string,
  path: string,
  runDir: string,
): Promise<EvidenceItem> {
  const relativePath = projectPath(path)
  const info = await stat(path)
  const rawRelation = relative(join(runDir, 'raw'), path)
  const screenshotRelation = relative(join(runDir, 'raw', 'screenshots'), path)
  const kind =
    (!screenshotRelation.startsWith('..') &&
      !isAbsolute(screenshotRelation) &&
      ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(
        basename(path).toLowerCase().replace(/^.*(\.[^.]+)$/, '$1'),
      ))
      ? 'screenshot'
      : basename(path) === 'scope.snapshot.json'
      ? 'scope'
      : basename(path) === 'targets.txt'
        ? 'targets'
        : rawRelation === '' ||
            (!rawRelation.startsWith('..') && !isAbsolute(rawRelation))
          ? 'raw-output'
          : basename(path) === 'findings.json' ||
              basename(path) === 'evidence-index.json'
            ? 'generated'
            : 'manifest'

  return {
    id,
    kind,
    path: relativePath,
    description: evidenceDescription(path, kind),
    sha256: await sha256File(path),
    bytes: info.size,
  }
}

function evidenceDescription(path: string, kind: EvidenceItem['kind']): string {
  const name = basename(path)
  if (name === 'run.json') return 'Profile run manifest'
  if (name === 'scope.snapshot.json') return 'Scope snapshot used for the run'
  if (name === 'command-manifest.json') return 'Planned or executed command manifest'
  if (name === 'targets.txt') return 'Normalized target list'
  if (kind === 'screenshot') return `Screenshot evidence: ${name}`
  if (kind === 'raw-output') return `Raw output: ${name}`
  if (kind === 'generated') return `Generated report artifact: ${name}`
  return `Run artifact: ${name}`
}

async function collectEvidence(runDir: string): Promise<EvidenceItem[]> {
  const fixed = [
    join(runDir, 'run.json'),
    join(runDir, 'scope.snapshot.json'),
    join(runDir, 'command-manifest.json'),
    join(runDir, 'targets.txt'),
  ]
  const rawFiles = await walkFiles(join(runDir, 'raw'))
  const files = [...fixed, ...rawFiles]
  const evidence: EvidenceItem[] = []
  for (const path of files) {
    if (!(await pathExists(path))) continue
    const info = await stat(path)
    if (!info.isFile()) continue
    evidence.push(
      await evidenceItem(`EV-${String(evidence.length + 1).padStart(3, '0')}`, path, runDir),
    )
  }
  return evidence
}

function headersFindingText(header: string): {
  description: string
  impact: string
  remediation: string
} {
  return {
    description: `${header} was not observed in the stored response headers. Header absence is a baseline indicator and should be confirmed against the full application before being treated as a vulnerability.`,
    impact:
      'The application may be missing a browser-side hardening control, depending on the endpoint role and any compensating controls.',
    remediation:
      'Review the application security header policy and add the header where it fits the application design. Validate in a staging environment before broad rollout.',
  }
}

async function normalizeBaseline(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'baseline-url.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const findings: Finding[] = []
  const target = stringValue(data, 'target') ?? targetLabel(context.run)
  const responseUrl = stringValue(data, 'responseUrl') ?? target
  const status = numberValue(data, 'status')
  const statusText = stringValue(data, 'statusText') ?? ''
  const headers = lowerHeaders(data.headers)
  const isHttps = responseUrl.toLowerCase().startsWith('https://')

  findings.push(
    addFinding({
      title: 'HTTP baseline response recorded',
      severity: 'info',
      confidence: 'high',
      status: 'informational',
      category: 'http-baseline',
      target,
      sourceTool: 'redscope-internal-http-baseline',
      evidence: [
        evidenceRef(context, relativePath, 'Stored HTTP status and selected headers', '/status'),
      ],
      description: `The authorized URL returned HTTP ${status ?? 'unknown'}${statusText ? ` ${statusText}` : ''}. RedScope stored status metadata, selected headers, and derived fingerprint signals only; the response body was not persisted.`,
      impact:
        'This observation anchors the baseline review and does not indicate a vulnerability by itself.',
      remediation:
        'Use this response metadata as context for manual review and later authorized validation phases.',
      references: [],
    }),
  )

  if (status != null && status >= 500) {
    findings.push(
      addFinding({
        title: 'Server error status observed during baseline fetch',
        severity: 'low',
        confidence: 'medium',
        status: 'suspected',
        category: 'availability-baseline',
        target,
        sourceTool: 'redscope-internal-http-baseline',
        evidence: [
          evidenceRef(context, relativePath, 'Stored HTTP status', '/status'),
        ],
        description: `The baseline request returned HTTP ${status}. This may indicate a transient server issue, a blocked baseline request, or an application error.`,
        impact:
          'Repeated server-side errors can reduce service reliability or hide application behavior during assessment.',
        remediation:
          'Confirm the result with the application owner and review server-side logs for the authorized test window.',
        references: [],
      }),
    )
  }

  if (status != null && status >= 300 && status < 400 && headers.location) {
    findings.push(
      addFinding({
        title: 'Redirect observed during baseline fetch',
        severity: 'info',
        confidence: 'high',
        status: 'informational',
        category: 'http-baseline',
        target,
        sourceTool: 'redscope-internal-http-baseline',
        evidence: [
          evidenceRef(context, relativePath, 'Stored redirect location', '/headers/location'),
        ],
        description: `The endpoint returned a redirect to ${headers.location}.`,
        impact:
          'Redirect behavior is normal for many applications, but it should stay within the authorized scope and intended host boundary.',
        remediation:
          'Confirm that redirects for scoped entry points stay within approved domains and expected login or canonicalization flows.',
        references: [],
      }),
    )
  }

  const headerChecks: Array<{
    header: string
    title: string
    severity: Severity
    confidence: Confidence
    when?: boolean
  }> = [
    {
      header: 'strict-transport-security',
      title: 'HSTS header not observed',
      severity: 'low',
      confidence: 'medium',
      when: isHttps,
    },
    {
      header: 'content-security-policy',
      title: 'Content Security Policy header not observed',
      severity: 'low',
      confidence: 'medium',
    },
    {
      header: 'x-content-type-options',
      title: 'X-Content-Type-Options header not observed',
      severity: 'low',
      confidence: 'medium',
    },
    {
      header: 'x-frame-options',
      title: 'Frame control header not observed',
      severity: 'low',
      confidence: 'low',
      when: !headers['content-security-policy']?.toLowerCase().includes('frame-ancestors'),
    },
    {
      header: 'referrer-policy',
      title: 'Referrer-Policy header not observed',
      severity: 'info',
      confidence: 'medium',
    },
    {
      header: 'permissions-policy',
      title: 'Permissions-Policy header not observed',
      severity: 'info',
      confidence: 'medium',
    },
  ]

  for (const check of headerChecks) {
    if (check.when === false || headers[check.header]) continue
    const text = headersFindingText(check.header)
    findings.push(
      addFinding({
        title: check.title,
        severity: check.severity,
        confidence: check.confidence,
        status: check.severity === 'info' ? 'informational' : 'suspected',
        category: 'security-header-baseline',
        target,
        sourceTool: 'redscope-internal-http-baseline',
        evidence: [
          evidenceRef(context, relativePath, 'Stored selected response headers', '/headers'),
        ],
        description: text.description,
        impact: text.impact,
        remediation: text.remediation,
        references: [],
      }),
    )
  }

  if (headers.server) {
    findings.push(
      addFinding({
        title: 'Server header exposed',
        severity: 'info',
        confidence: 'high',
        status: 'informational',
        category: 'information-disclosure-baseline',
        target,
        sourceTool: 'redscope-internal-http-baseline',
        evidence: [
          evidenceRef(context, relativePath, 'Stored Server header', '/headers/server'),
        ],
        description:
          'A Server header was present in the baseline response. The exact value is retained in the raw evidence and should be reviewed for unnecessary version disclosure.',
        impact:
          'Verbose platform headers can give attackers extra fingerprinting context, although this is usually low impact on its own.',
        remediation:
          'Minimize product and version disclosure in server-generated headers where operationally feasible.',
        references: [],
      }),
    )
  }

  return findings
}

function gitleaksRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value)) {
    const findings = arrayValue(value, 'findings').filter(isRecord)
    if (findings.length > 0) return findings
    const leaks = arrayValue(value, 'leaks').filter(isRecord)
    if (leaks.length > 0) return leaks
  }
  return []
}

async function normalizeGitleaks(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'gitleaks.json')
  const data = await readJsonIfExists<unknown>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const findings: Finding[] = []
  const rows = gitleaksRows(data)

  rows.forEach((row, index) => {
    const rule = stringValue(row, 'RuleID') ?? stringValue(row, 'ruleID') ?? 'secret-rule'
    const description =
      stringValue(row, 'Description') ??
      stringValue(row, 'description') ??
      'Gitleaks reported a potential secret.'
    const file = stringValue(row, 'File') ?? stringValue(row, 'file') ?? 'unknown file'
    const startLine = numberValue(row, 'StartLine') ?? numberValue(row, 'line')
    const fingerprint = stringValue(row, 'Fingerprint') ?? stringValue(row, 'fingerprint')
    const target = `${file}${startLine ? `:${startLine}` : ''}`

    findings.push(
      addFinding({
        title: `Potential secret detected by Gitleaks: ${rule}`,
        severity: 'high',
        confidence: 'high',
        status: 'confirmed',
        category: 'secret-scanning',
        target,
        sourceTool: 'gitleaks',
        evidence: [
          evidenceRef(
            context,
            relativePath,
            'Redacted Gitleaks JSON finding',
            `/${index}`,
            startLine,
          ),
        ],
        description: `${description} The RedScope pipeline intentionally does not copy the matched secret or raw match text into the normalized finding.`,
        impact:
          'Committed credentials or tokens may allow unauthorized access if the value is still valid or has been reused elsewhere.',
        remediation:
          `Rotate or revoke the affected secret, remove it from version history where appropriate, and add a prevention control for rule ${rule}.${fingerprint ? ` Fingerprint: ${fingerprint}.` : ''}`,
        references: [],
      }),
    )
  })

  return findings
}

async function normalizeSemgrep(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'semgrep.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const findings: Finding[] = []
  const results = arrayValue(data, 'results').filter(isRecord)

  results.forEach((result, index) => {
    const extra = recordValue(result, 'extra')
    const checkId = stringValue(result, 'check_id') ?? 'semgrep-rule'
    const file = stringValue(result, 'path') ?? 'unknown file'
    const start = recordValue(result, 'start')
    const line = numberValue(start, 'line')
    const message =
      stringValue(extra, 'message') ??
      stringValue(result, 'message') ??
      'Semgrep reported a static-analysis finding.'
    const severity = severityFromSemgrep(stringValue(extra, 'severity'))

    findings.push(
      addFinding({
        title: `Semgrep finding: ${checkId}`,
        severity,
        confidence: severity === 'info' ? 'medium' : 'high',
        status: severity === 'info' ? 'informational' : 'suspected',
        category: 'static-analysis',
        target: `${file}${line ? `:${line}` : ''}`,
        sourceTool: 'semgrep',
        evidence: [
          evidenceRef(
            context,
            relativePath,
            'Semgrep JSON result',
            `/results/${index}`,
            line,
          ),
        ],
        description: message,
        impact:
          'Static-analysis results require source review to confirm reachability and exploitability.',
        remediation:
          'Review the flagged code path, apply the rule-specific fix, and add regression coverage where practical.',
        references: [],
      }),
    )
  })

  return findings
}

function parseJsonLines(path: string, content: string, warnings: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isRecord(parsed)) rows.push(parsed)
      else warnings.push(`${path}:${index + 1} is not a JSON object`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`${path}:${index + 1} could not be parsed as JSONL: ${message}`)
    }
  })
  return rows
}

async function normalizeHttpx(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'httpx.jsonl')
  if (!(await pathExists(rawPath))) return []

  const relativePath = projectPath(rawPath)
  const rows = parseJsonLines(
    relativePath,
    await readFile(rawPath, 'utf8'),
    context.warnings,
  )
  const findings: Finding[] = []

  rows.forEach((row, index) => {
    const url =
      stringValue(row, 'url') ??
      stringValue(row, 'input') ??
      stringValue(row, 'host') ??
      targetLabel(context.run)
    const status = numberValue(row, 'status_code') ?? numberValue(row, 'status-code')
    const title = stringValue(row, 'title')
    const webserver = stringValue(row, 'webserver') ?? stringValue(row, 'server')
    const technologies = stringList(row.technologies ?? row.tech)
    const severity: Severity = status != null && status >= 500 ? 'low' : 'info'

    findings.push(
      addFinding({
        title: status != null ? `HTTP service observed (${status})` : 'HTTP service observed',
        severity,
        confidence: 'high',
        status: severity === 'info' ? 'informational' : 'suspected',
        category: 'http-probe',
        target: url,
        sourceTool: 'httpx',
        evidence: [
          evidenceRef(context, relativePath, 'httpx JSONL result', undefined, index + 1),
        ],
        description: [
          `httpx observed an HTTP response for ${url}.`,
          title ? `Title: ${title}.` : '',
          webserver ? `Web server: ${webserver}.` : '',
          technologies.length > 0 ? `Technologies: ${technologies.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        impact:
          severity === 'low'
            ? 'A server-side error response may indicate an unstable endpoint or blocked request path.'
            : 'This is an asset inventory observation and does not indicate a vulnerability by itself.',
        remediation:
          severity === 'low'
            ? 'Confirm whether the error is repeatable during the authorized test window and review service logs.'
            : 'Use this observation to maintain the approved asset inventory and prioritize follow-up review.',
        references: [],
      }),
    )
  })

  return findings
}

async function normalizeNuclei(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'nuclei-low.jsonl')
  if (!(await pathExists(rawPath))) return []

  const relativePath = projectPath(rawPath)
  const rows = parseJsonLines(
    relativePath,
    await readFile(rawPath, 'utf8'),
    context.warnings,
  )
  const findings: Finding[] = []

  rows.forEach((row, index) => {
    const info = recordValue(row, 'info')
    const templateId =
      stringValue(row, 'template-id') ??
      stringValue(row, 'templateID') ??
      'nuclei-template'
    const name = stringValue(info, 'name') ?? templateId
    const severity = severityFromNuclei(stringValue(info, 'severity'))
    const target =
      stringValue(row, 'matched-at') ??
      stringValue(row, 'host') ??
      stringValue(row, 'url') ??
      targetLabel(context.run)
    const description =
      stringValue(info, 'description') ??
      'Nuclei reported a low-impact template match.'
    const remediation =
      stringValue(info, 'remediation') ??
      'Review the matched condition with the application owner and apply the template-specific hardening guidance if confirmed.'

    findings.push(
      addFinding({
        title: `Nuclei template match: ${name}`,
        severity,
        confidence: severity === 'info' ? 'medium' : 'high',
        status: severity === 'info' ? 'informational' : 'suspected',
        category: 'nuclei-low-impact',
        target,
        sourceTool: 'nuclei',
        evidence: [
          evidenceRef(context, relativePath, 'Nuclei JSONL result', undefined, index + 1),
        ],
        description: `${description} Template: ${templateId}.`,
        impact:
          severity === 'info'
            ? 'This is an informational template match and should be used as assessment context.'
            : 'The matched condition may represent a low-impact exposure or misconfiguration that needs manual confirmation.',
        remediation,
        references: [],
        testProcess: [
          'Validated that the run used a scope-backed active profile before nuclei output was normalized.',
          `Ran or planned the nuclei low-impact JSONL step and reviewed result line ${index + 1}.`,
          `Recorded template identifier ${templateId} and matched target metadata without storing response bodies in the report.`,
          'Treat the result as suspected until an analyst confirms it with the system owner and approved evidence.',
        ],
        screenshots: screenshotEvidenceRefs(context),
      }),
    )
  })

  return findings
}

async function normalizeLowImpactValidation(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'low-impact-validation.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const results = arrayValue(data, 'results').filter(isRecord)
  const verified = results.filter(
    item =>
      stringValue(item, 'status') === 'verified' &&
      booleanValue(item, 'impactVerified') === true,
  )
  const findings: Finding[] = []
  const screenshots = screenshotEvidenceRefs(context)

  verified.forEach((result, index) => {
    const approval = recordValue(result, 'approval')
    const responseEvidence = recordValue(result, 'responseEvidence')
    const validatorId = stringValue(result, 'id') ?? `validator-${index + 1}`
    const title = stringValue(result, 'title') ?? validatorId
    const method = stringValue(result, 'method') ?? 'low-impact'
    const target = stringValue(result, 'target') ?? targetLabel(context.run)
    const statefulMode =
      mode === 'approved-state-changing-http' ||
      context.run.profile?.id === 'authorized-stateful-business-logic-validation'
    const sourceTool = statefulMode
      ? 'redscope-internal-stateful-business-logic-validator'
      : 'redscope-internal-business-logic-validator'
    const severityValue = stringValue(result, 'severity')
    const severity: Severity =
      severityValue === 'medium' || severityValue === 'low' || severityValue === 'info'
        ? severityValue
        : 'low'
    const approvedBy = stringValue(approval, 'approvedBy') ?? 'unknown'
    const approvalReference =
      stringValue(approval, 'approvalReference') ?? 'unknown'
    const responseStatus = numberValue(responseEvidence, 'status')
    const candidateCves = stringList(result.candidateCves)
    const cpe23Names = stringList(result.cpe23Names)
    const evidenceNotes = stringList(result.evidence)

    findings.push(
      addFinding({
        title: `Target-verified low-impact issue: ${title}`,
        severity,
        confidence: 'high',
        status: 'confirmed',
        category: stringValue(result, 'category') ?? 'low-impact-validation',
        evidenceClass: 'target-verified-issue',
        target,
        sourceTool: 'redscope-internal-low-impact-validator',
        evidence: [
          evidenceRef(
            context,
            relativePath,
            'Low-impact validator result',
            `/results/${results.indexOf(result)}`,
          ),
        ],
        description: [
          `A separately authorized low-impact validator (${validatorId}) verified the target condition using ${method}.`,
          responseStatus != null ? `Observed HTTP status ${responseStatus}.` : '',
          candidateCves.length > 0 ? `Candidate CVE IDs: ${candidateCves.join(', ')}.` : '',
          cpe23Names.length > 0 ? `CPE evidence: ${cpe23Names.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        impact:
          stringValue(result, 'impact') ??
          'The target condition was verified inside the authorized scope.',
        remediation:
          stringValue(result, 'remediation') ??
          'Remediate the confirmed target condition and rerun the approved low-impact validator.',
        references: stringList(result.references),
        testProcess: [
          'Validated that the run used a scope-backed active low-impact validator profile.',
          `Confirmed separate validator approval by ${approvedBy} (${approvalReference}).`,
          'Executed only the configured same-origin GET/HEAD validator with no request body.',
          'Stored response metadata, digests, hashes, and assertion outcomes without storing raw response body text.',
          ...evidenceNotes.map(item => `Validator evidence: ${item}`),
        ],
        screenshots,
        validation: {
          validatorId,
          method,
          impactVerified: true,
          approvedBy,
          approvalReference,
          responseStatus,
          candidateCves,
          cpe23Names,
          arbitraryPocExecutionAllowed: false,
          requestBodySent: false,
          rawBodyStored: false,
        },
      }),
    )
  })

  if (verified.length > 0) return findings

  const validatorCount = numberValue(data, 'validatorCount') ?? results.length
  const failedCount = results.filter(
    item => stringValue(item, 'status') === 'failed',
  ).length
  return [
    addFinding({
      title: 'Low-impact validators completed without target-verified issues',
      severity: 'info',
      confidence: failedCount > 0 ? 'medium' : 'high',
      status: 'informational',
      category: 'low-impact-validation',
      evidenceClass: 'target-fingerprint-correlation',
      target: stringValue(data, 'target') ?? targetLabel(context.run),
      sourceTool: 'redscope-internal-low-impact-validator',
      evidence: [
        evidenceRef(
          context,
          relativePath,
          'Low-impact validation summary',
          '/results',
        ),
      ],
      description: `RedScope evaluated ${validatorCount} approved low-impact validator(s); none produced verified target impact. Failed validator count: ${failedCount}.`,
      impact:
        'No target-verified issue was promoted from this validator run. This does not prove absence of vulnerability outside the configured checks.',
      remediation:
        'Review validator configuration, candidate readiness, and owner-confirmed version evidence before adding or rerunning validators.',
      references: [],
      testProcess: [
        'Validated the active scope and separate low-impact validator profile.',
        'Executed only configured same-origin GET/HEAD validators with no request bodies.',
        'Did not promote public intelligence, advisory metadata, or failed assertions to target-verified issues.',
      ],
      screenshots,
      validation: {
        validatorCount,
        verifiedCount: 0,
        failedCount,
        arbitraryPocExecutionAllowed: false,
        rawBodyStored: false,
      },
    }),
  ]
}

async function normalizeBusinessLogicValidation(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'business-logic-validation.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const results = arrayValue(data, 'results').filter(isRecord)
  const verified = results.filter(
    item =>
      stringValue(item, 'status') === 'verified' &&
      booleanValue(item, 'impactVerified') === true,
  )
  const findings: Finding[] = []
  const screenshots = screenshotEvidenceRefs(context)

  verified.forEach((result, index) => {
    const approval = recordValue(result, 'approval')
    const actors = recordValue(result, 'actors')
    const validatorId = stringValue(result, 'id') ?? `logic-test-${index + 1}`
    const title = stringValue(result, 'title') ?? validatorId
    const mode = stringValue(result, 'validationMode') ?? 'business-logic'
    const category = stringValue(result, 'category') ?? 'business-logic'
    const target = stringValue(result, 'target') ?? targetLabel(context.run)
    const severityValue = stringValue(result, 'severity')
    const severity: Severity =
      severityValue === 'critical' ||
      severityValue === 'high' ||
      severityValue === 'medium' ||
      severityValue === 'low' ||
      severityValue === 'info'
        ? severityValue
        : 'high'
    const approvedBy = stringValue(approval, 'approvedBy') ?? 'unknown'
    const approvalReference =
      stringValue(approval, 'approvalReference') ?? 'unknown'
    const requestEvidence = arrayValue(result, 'requestEvidence').filter(isRecord)
    const requestStatuses = requestEvidence.map(item => ({
      actorId: stringValue(item, 'actorId'),
      role: stringValue(item, 'role'),
      method: stringValue(item, 'method'),
      status: numberValue(item, 'status'),
      rawBodyStored: booleanValue(item, 'rawBodyStored') ?? false,
      headerValueStored: booleanValue(item, 'headerValueStored') ?? false,
      requestBodyStored: booleanValue(item, 'requestBodyStored') ?? false,
      requestBodySha256: stringValue(item, 'requestBodySha256'),
    }))
    const cweIds = stringList(result.cweIds)
    const evidenceNotes = stringList(result.evidence)
    const manualEvidenceRefs = stringList(result.manualEvidenceRefs)

    findings.push(
      addFinding({
        title: `Target-verified business logic issue: ${title}`,
        severity,
        confidence: 'high',
        status: 'confirmed',
        category,
        evidenceClass: 'target-verified-issue',
        target,
        sourceTool,
        evidence: [
          evidenceRef(
            context,
            relativePath,
            'Business logic validator result',
            `/results/${results.indexOf(result)}`,
          ),
        ],
        description: [
          `A separately authorized business-logic validator (${validatorId}) verified target impact using ${mode}.`,
          `Category: ${category}.`,
          stringValue(actors, 'testActor')
            ? `Test actor: ${stringValue(actors, 'testActor')}.`
            : '',
          stringValue(actors, 'controlActor')
            ? `Control actor: ${stringValue(actors, 'controlActor')}.`
            : '',
          cweIds.length > 0 ? `CWE: ${cweIds.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        impact:
          stringValue(result, 'impact') ??
          'The target business workflow allowed an action or data view that violated the approved ownership, role, or state expectation.',
        remediation:
          stringValue(result, 'remediation') ??
          'Enforce server-side ownership, role, amount, state-transition, and replay protections for the affected business workflow.',
        references: stringList(result.references),
        testProcess: [
          'Validated that the run used a scope-backed active business-logic validation profile.',
          `Confirmed separate business-logic approval by ${approvedBy} (${approvalReference}).`,
          mode === 'safe-readonly-http'
            ? 'Executed only same-origin GET/HEAD checks with no request body, no payload fuzzing, and no raw body storage.'
            : statefulMode
              ? 'Executed only fixed same-origin state-changing HTTP requests declared in scope, with no fuzzing, generated payloads, raw body storage, or secret header storage.'
              : 'Relied on approved analyst evidence references for state-changing or payment-sensitive workflows.',
          'Did not promote planned, failed, denied, or manual-review-only test cases to target-verified issues.',
          ...evidenceNotes.map(item => `Validator evidence: ${item}`),
        ],
        screenshots,
        validation: {
          validatorId,
          mode,
          category,
          impactVerified: true,
          approvedBy,
          approvalReference,
          actors,
          affectedObject: stringValue(result, 'affectedObject'),
          requestStatuses,
          manualEvidenceRefs,
          cweIds,
          arbitraryPocExecutionAllowed: false,
          mutatingRequestsAllowedByDefault: statefulMode,
          rawBodyStored: false,
          secretHeaderStored: false,
        },
      }),
    )
  })

  if (verified.length > 0) return findings

  const testCaseCount = numberValue(data, 'testCaseCount') ?? results.length
  const manualReviewCount = results.filter(
    item => stringValue(item, 'status') === 'manual-review',
  ).length
  const failedCount = results.filter(
    item => stringValue(item, 'status') === 'failed',
  ).length
  const statefulRun =
    context.run.profile?.id === 'authorized-stateful-business-logic-validation'
  return [
    addFinding({
      title: 'Business logic validators completed without target-verified issues',
      severity: 'info',
      confidence: failedCount > 0 ? 'medium' : 'high',
      status: 'informational',
      category: 'business-logic-validation',
      evidenceClass: 'target-fingerprint-correlation',
      target: stringValue(data, 'target') ?? targetLabel(context.run),
      sourceTool: statefulRun
        ? 'redscope-internal-stateful-business-logic-validator'
        : 'redscope-internal-business-logic-validator',
      evidence: [
        evidenceRef(
          context,
          relativePath,
          'Business logic validation summary',
          '/results',
        ),
      ],
      description: `RedScope evaluated ${testCaseCount} approved business-logic test case(s); none produced target-verified impact. Manual-review-only cases: ${manualReviewCount}. Failed cases: ${failedCount}.`,
      impact:
        'No business-logic issue was promoted from this run. This does not prove absence of authorization, payment, upload, SQL injection, or workflow-state vulnerabilities outside the declared test cases.',
      remediation:
        'Review the business workflow map, actor matrix, object ownership evidence, and isolated parallel lanes before adding or rerunning test cases.',
      references: [],
      testProcess: [
        statefulRun
          ? 'Validated the active scope and separate stateful business-logic validator profile.'
          : 'Validated the active scope and separate business-logic validator profile.',
        'Kept manual-review, failed, skipped, and not-verified cases below target-verified severity.',
        statefulRun
          ? 'Executed no arbitrary PoC code, generated fuzz payloads, credential attacks, payment captures, destructive uploads, or scanner templates.'
          : 'Did not execute arbitrary PoC code, fuzz payloads, payment captures, destructive uploads, or raw SQL injection payloads by default.',
      ],
      screenshots,
      validation: {
        testCaseCount,
        verifiedCount: 0,
        manualReviewCount,
        failedCount,
        arbitraryPocExecutionAllowed: false,
        mutatingRequestsAllowedByDefault: statefulRun,
        rawBodyStored: false,
        secretHeaderStored: false,
      },
    }),
  ]
}

async function normalizePocValidationPlan(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'poc-validation-plan.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const target = stringValue(data, 'target') ?? targetLabel(context.run)
  const fingerprints = recordValue(data, 'fingerprints')
  const products = stringList(fingerprints?.products)
  const versions = stringList(fingerprints?.versions)
  const fingerprintConfidence =
    confidenceValue(stringValue(fingerprints, 'confidence')) ?? 'low'
  const fingerprintScore = numberValue(fingerprints, 'confidenceScore') ?? 0
  const productVersionPairCount = arrayValue(
    fingerprints,
    'productVersionPairs',
  ).length
  const ownerConfirmedEvidence = arrayValue(
    fingerprints,
    'ownerConfirmedVersionEvidence',
  ).filter(isRecord)
  const ownerConfirmedEvidenceCount = ownerConfirmedEvidence.length
  const fingerprintCpes = stringList(fingerprints?.cpe23Names)
  const fingerprintVendors = stringList(fingerprints?.vendorHints)
  const candidates = arrayValue(data, 'candidates').filter(isRecord)
  const triageQueue = arrayValue(data, 'triageQueue').filter(isRecord)
  const plannedAttempts = arrayValue(data, 'plannedAttempts').filter(isRecord)
  const candidateCount = numberValue(data, 'candidateCount') ?? candidates.length
  const rawCandidateCount =
    numberValue(data, 'rawCandidateCount') ?? candidateCount + triageQueue.length
  const triageQueueCount =
    numberValue(data, 'triageQueueCount') ?? triageQueue.length
  const candidateScores = candidates
    .map(item => numberValue(item, 'evidenceScore'))
    .filter((item): item is number => item != null)
  const highestCandidateScore =
    candidateScores.length > 0 ? Math.max(...candidateScores) : undefined
  const candidateConfidence =
    confidenceValue(
      candidates
        .map(item => stringValue(item, 'confidence'))
        .find((item): item is string => Boolean(item)),
    ) ?? confidenceFromScore(highestCandidateScore)
  const matchedCves = uniqueSorted(
    candidates.flatMap(item => stringList(item.matchedCves)),
  )
  const matchedCpes = uniqueSorted(
    candidates.flatMap(item => stringList(item.matchedCpe23Names)),
  )
  const matchedVendors = uniqueSorted(
    candidates.flatMap(item => stringList(item.matchedVendors)),
  )
  const candidateEvidenceClass =
    strongestEvidenceClass(
      candidates
        .map(item => evidenceClassValue(stringValue(item, 'evidenceClass')))
        .filter((item): item is EvidenceClass => item !== undefined),
    ) ?? 'target-fingerprint-correlation'
  const screenshots = screenshotEvidenceRefs(context)
  const matchedSourcePaths = candidates
    .map(item => stringValue(item, 'sourcePath'))
    .filter((item): item is string => Boolean(item))
    .slice(0, 12)
  const searchRawPath = join(context.runDir, 'raw', 'poc-search-enrichment.json')
  const searchData = await readJsonIfExists<Record<string, unknown>>(searchRawPath)
  const searchRelativePath = projectPath(searchRawPath)
  const searchResults = arrayValue(searchData, 'results').filter(isRecord)
  const searchErrors = arrayValue(searchData, 'errors').filter(isRecord)
  const searchResultCount =
    numberValue(searchData, 'resultCount') ?? searchResults.length
  const searchQueryCount = numberValue(searchData, 'queryCount') ?? 0
  const searchProviders = stringList(searchData?.providers)
  const searchReferences = searchResults
    .map(item => stringValue(item, 'url'))
    .filter((item): item is string => Boolean(item))
    .slice(0, 12)
  const topExternalCves = uniqueSorted(
    searchResults.flatMap(item => stringList(item.matchedCves)),
  ).slice(0, 12)
  const advisoryRawPath = join(
    context.runDir,
    'raw',
    'vulnerability-advisory-enrichment.json',
  )
  const advisoryData =
    await readJsonIfExists<Record<string, unknown>>(advisoryRawPath)
  const advisoryRelativePath = projectPath(advisoryRawPath)
  const advisoryRecords = arrayValue(advisoryData, 'advisories').filter(isRecord)
  const advisoryErrors = arrayValue(advisoryData, 'errors').filter(isRecord)
  const advisoryResultCount =
    numberValue(advisoryData, 'resultCount') ?? advisoryRecords.length
  const advisoryQueryCount = numberValue(advisoryData, 'queryCount') ?? 0
  const advisoryProviders = stringList(advisoryData?.providers)
  const advisoryCves = uniqueSorted(
    advisoryRecords
      .map(item => stringValue(item, 'cveId'))
      .filter((item): item is string => Boolean(item)),
  ).slice(0, 16)
  const advisoryCpes = uniqueSorted(
    advisoryRecords.flatMap(item => stringList(item.matchedCpe23Names)),
  ).slice(0, 16)
  const kevCves = uniqueSorted(
    advisoryRecords
      .filter(item => booleanValue(item, 'cisaKev') === true)
      .map(item => stringValue(item, 'cveId'))
      .filter((item): item is string => Boolean(item)),
  ).slice(0, 16)
  const advisoryScores = advisoryRecords
    .map(item => numberValue(item, 'cvssScore'))
    .filter((item): item is number => item != null)
  const maxCvssScore =
    advisoryScores.length > 0 ? Math.max(...advisoryScores) : undefined
  const advisoryReferences = advisoryRecords
    .flatMap(item => stringList(item.references))
    .slice(0, 16)
  const gatesRawPath = join(context.runDir, 'raw', 'validation-evidence-gates.json')
  const gatesData = await readJsonIfExists<Record<string, unknown>>(gatesRawPath)
  const gatesRelativePath = projectPath(gatesRawPath)
  const gatedCandidates = arrayValue(gatesData, 'candidates').filter(isRecord)
  const gateCandidateCount =
    numberValue(gatesData, 'candidateCount') ?? gatedCandidates.length
  const validationReadyCount =
    numberValue(gatesData, 'validationReadyCount') ??
    gatedCandidates.filter(
      item =>
        stringValue(item, 'status') ===
        'ready-for-approved-low-impact-validation',
    ).length
  const gateScores = gatedCandidates
    .map(item => numberValue(item, 'gateScore'))
    .filter((item): item is number => item != null)
  const highestGateScore =
    gateScores.length > 0 ? Math.max(...gateScores) : undefined

  const baseTestProcess = [
    'Validated that the target is covered by the written scope and active testing level.',
    'Fetched the authorized URL once to record low-impact fingerprint headers and derived body/cookie signature metadata.',
    `Scored fingerprint confidence as ${fingerprintConfidence} (${fingerprintScore}/100) from selected headers and derived signatures.`,
    'Extracted product, version, and same-header product/version pair indicators.',
    'Derived vendor and CPE 2.3 hints, then merged any owner-confirmed product/version evidence declared in scope.technologyEvidence.',
    'Compared those indicators against downloaded source trees under tools/sources with CPE, CVE, reviewed-template, and context scoring.',
    'Promoted only multi-evidence candidates to gated validation attempts; public-intelligence-only and product-only hits remain triage leads.',
    'Generated a gated validation-attempt plan without executing arbitrary PoC code.',
  ]

  function buildExternalSearchFinding(): Finding | undefined {
    if (!searchData) return undefined
    return addFinding({
        title:
          searchResultCount > 0
            ? 'External PoC search enrichment collected candidate links'
            : 'External PoC search enrichment found no candidate links',
        severity: 'info',
        confidence: searchErrors.length > 0 ? 'medium' : 'high',
        status: 'informational',
        category: 'poc-search-enrichment',
        evidenceClass: 'public-intelligence-lead',
        target,
        sourceTool: 'redscope-internal-poc-candidate-validation',
        evidence: [
          evidenceRef(
            context,
            searchRelativePath,
            'External PoC search enrichment metadata',
            '/results',
          ),
        ],
        description: `RedScope queried external PoC/search sources (${searchProviders.join(', ') || 'none'}) using product/version/CVE fingerprint terms only. It recorded ${searchResultCount} candidate link(s), ${searchQueryCount} query term set(s), and ${searchErrors.length} provider/query error(s). Matched CVE IDs in external results: ${topExternalCves.join(', ') || 'none'}.`,
        impact:
          'External search links can improve coverage for newly published PoCs, but they are untrusted metadata and do not confirm exploitability.',
        remediation:
          'Review external links manually, prefer vendor advisories or reviewed low-impact templates, and do not download or execute PoC code without a separate approved validation workflow.',
        references: searchReferences,
        testProcess: [
          ...baseTestProcess,
          'Generated external search queries from fingerprint terms without including the target hostname.',
          'Searched GitHub and public search engines for candidate links and stored metadata only.',
          'Did not download repositories, copy PoC code, or execute external content.',
        ],
        screenshots,
        validation: {
          externalSearchStatus: stringValue(searchData, 'status') ?? 'unknown',
          providerCount: searchProviders.length,
          searchQueryCount,
          searchResultCount,
          searchErrorCount: searchErrors.length,
          matchedCves: topExternalCves,
          targetHostIncludedInQueries: false,
          downloadsAllowed: false,
          arbitraryPocExecutionAllowed: false,
        },
      })
  }

  function buildAdvisoryFinding(): Finding | undefined {
    if (!advisoryData) return undefined
    return addFinding({
        title:
          advisoryResultCount > 0
            ? 'Authoritative vulnerability advisory enrichment matched fingerprint terms'
            : 'Authoritative vulnerability advisory enrichment found no matches',
        severity: 'info',
        confidence: advisoryErrors.length > 0 ? 'medium' : 'high',
        status: 'informational',
        category: 'vulnerability-advisory-enrichment',
        evidenceClass: 'public-intelligence-lead',
        target,
        sourceTool: 'redscope-internal-poc-candidate-validation',
        evidence: [
          evidenceRef(
            context,
            advisoryRelativePath,
            'Authoritative vulnerability advisory enrichment metadata',
            '/advisories',
          ),
        ],
        description: `RedScope queried authoritative vulnerability metadata (${advisoryProviders.join(', ') || 'none'}) using CPE/CVE/product/version fingerprint terms only. It recorded ${advisoryResultCount} advisory record(s), ${advisoryQueryCount} query term set(s), and ${advisoryErrors.length} provider/query error(s). CVE IDs: ${advisoryCves.join(', ') || 'none'}. CPE matches: ${advisoryCpes.join(', ') || 'none'}. CISA KEV-linked CVE IDs: ${kevCves.join(', ') || 'none'}.`,
        impact:
          'Authoritative advisory metadata helps prioritize PoC leads and reduce search-engine noise, but it still does not prove the scoped target runs an affected build.',
        remediation:
          'Confirm the exact product and version with trusted owner evidence, prefer vendor/NVD/CISA references during triage, and only run separately approved low-impact validation methods.',
        references: advisoryReferences,
        testProcess: [
          ...baseTestProcess,
          'Queried NVD advisory metadata from CVE/product/version fingerprint terms without including the target hostname.',
          'Kept advisory records as prioritization metadata and did not download or execute referenced PoC content.',
          'Separated advisory correlation from suspected vulnerability findings to avoid inflating confidence from public metadata alone.',
        ],
        screenshots,
        validation: {
          advisoryStatus: stringValue(advisoryData, 'status') ?? 'unknown',
          advisoryProviderCount: advisoryProviders.length,
          advisoryQueryCount,
          advisoryResultCount,
          advisoryErrorCount: advisoryErrors.length,
          advisoryCves,
          advisoryCpes,
          cisaKevCves: kevCves,
          maxCvssScore,
          targetHostIncludedInQueries: false,
          downloadsAllowed: false,
          arbitraryPocExecutionAllowed: false,
        },
      })
  }

  function buildValidationGateFinding(): Finding | undefined {
    if (!gatesData) return undefined
    return addFinding({
        title:
          validationReadyCount > 0
            ? 'Automatic evidence gates marked candidates ready for approved low-impact validation'
            : 'Automatic evidence gates require more correlation before validation',
        severity: 'info',
        confidence:
          validationReadyCount > 0
            ? confidenceFromScore(highestGateScore)
            : 'high',
        status: 'informational',
        category: 'validation-evidence-gates',
        evidenceClass: 'target-fingerprint-correlation',
        target,
        sourceTool: 'redscope-internal-poc-candidate-validation',
        evidence: [
          evidenceRef(
            context,
            gatesRelativePath,
            'Automatic validation evidence gates',
            '/candidates',
          ),
        ],
        description: `RedScope evaluated ${gateCandidateCount} promoted candidate(s) against non-exploit evidence gates and marked ${validationReadyCount} candidate(s) ready for separately approved low-impact validation. Highest gate score: ${highestGateScore ?? 'none'}.`,
        impact:
          'Evidence gates reduce false positives by requiring fingerprint confidence, same-context product/version evidence, and advisory correlation before validation work proceeds.',
        remediation:
          validationReadyCount > 0
            ? 'Review the ready candidates, confirm owner-approved test conditions, and run only separately authorized low-impact validators.'
            : 'Collect stronger owner-confirmed product/version evidence, update advisory/source data, or manually review candidate context before any validation attempt.',
        references: [],
        testProcess: [
          ...baseTestProcess,
          'Checked fingerprint confidence, same-context version/CPE evidence, owner-confirmed version evidence, advisory correlation, external CVE corroboration, reviewed-template allowlist status, and no-exploit-execution gates.',
          'Did not execute exploit payloads or public PoC code while calculating validation readiness.',
        ],
        screenshots,
        validation: {
          gateStatus: stringValue(gatesData, 'status') ?? 'unknown',
          gateCandidateCount,
          validationReadyCount,
          highestGateScore,
          arbitraryPocExecutionAllowed: false,
          networkProbeExecutedByGate: false,
        },
      })
  }

  if (candidateCount === 0) {
    const title =
      triageQueueCount > 0
        ? 'Only low-confidence historical vulnerability leads were observed'
        : 'No PoC source candidates matched recorded fingerprints'
    const description =
      triageQueueCount > 0
        ? `RedScope observed ${triageQueueCount} low-confidence source hit(s), but none met the version/CVE/template evidence threshold for a validation attempt. Products: ${products.join(', ') || 'none'}. Versions: ${versions.join(', ') || 'none'}.`
        : 'RedScope did not find local PoC/template source files that matched the recorded product/version fingerprint terms.'
    const remediation =
      triageQueueCount > 0
        ? 'Treat these as research leads only. Improve fingerprint coverage, confirm exact product/version with the owner, and prefer vendor advisories or reviewed low-impact templates before validation.'
        : 'Review fingerprint coverage, update source repositories, and use vendor advisories or manually approved templates for further validation.'
    const planningFinding = addFinding({
        title,
        severity: 'info',
        confidence: triageQueueCount > 0 ? 'high' : 'medium',
        status: 'informational',
        category: 'poc-validation-planning',
        evidenceClass:
          ownerConfirmedEvidenceCount > 0
            ? 'owner-confirmed-target-version'
            : triageQueueCount > 0
            ? 'public-intelligence-lead'
            : 'target-fingerprint-correlation',
        target,
        sourceTool: 'redscope-internal-poc-candidate-validation',
        evidence: [
          evidenceRef(
            context,
            relativePath,
            'PoC candidate validation plan',
            '/candidateCount',
          ),
        ],
        description,
        impact:
          'This does not prove the target is not vulnerable; it only means the local source cache did not produce a direct candidate match.',
        remediation,
        references: [],
        testProcess: baseTestProcess,
        screenshots,
        validation: {
          candidateCount,
          rawCandidateCount,
          triageQueueCount,
          products,
          versions,
          productVersionPairCount,
          ownerConfirmedEvidenceCount,
          fingerprintCpes,
          fingerprintVendors,
          fingerprintConfidence,
          fingerprintScore,
          arbitraryPocExecutionAllowed: false,
        },
      })
    const externalSearchFinding = buildExternalSearchFinding()
    const advisoryFinding = buildAdvisoryFinding()
    const validationGateFinding = buildValidationGateFinding()
    return [
      planningFinding,
      ...(externalSearchFinding ? [externalSearchFinding] : []),
      ...(advisoryFinding ? [advisoryFinding] : []),
      ...(validationGateFinding ? [validationGateFinding] : []),
    ]
  }

  const candidateFinding = addFinding({
      title: 'Historical vulnerability candidates matched target fingerprint evidence',
      severity: 'low',
        confidence: candidateConfidence,
        status: 'suspected',
        category: 'poc-validation-candidate',
        evidenceClass: candidateEvidenceClass,
        target,
      sourceTool: 'redscope-internal-poc-candidate-validation',
      evidence: [
        evidenceRef(
          context,
          relativePath,
          'PoC candidate validation plan',
          '/plannedAttempts',
        ),
      ],
      description: `RedScope promoted ${candidateCount} local PoC/template candidate(s) from ${rawCandidateCount} raw source hit(s) after fingerprint, vendor, CPE, owner-confirmed version, reviewed-template, CVE, and source-confidence scoring. Products: ${products.join(', ') || 'none'}. Vendors: ${matchedVendors.join(', ') || 'none'}. Versions: ${versions.join(', ') || 'none'}. CPE matches: ${matchedCpes.slice(0, 8).join(', ') || 'none'}. CVE IDs referenced by promoted candidates: ${matchedCves.slice(0, 8).join(', ') || 'none'}.`,
      impact:
        'A candidate match is target fingerprint or owner-version correlation against public vulnerability material. It is not a target-verified issue until an approved low-impact validation method proves impact inside the authorized scope.',
      remediation:
        'Review the promoted source files, confirm exact product/version with trusted owner evidence, prefer non-destructive vendor checks or approved nuclei templates, capture screenshots during validation, and document owner-approved remediation steps for confirmed findings.',
      references: matchedSourcePaths,
      testProcess: [
        ...baseTestProcess,
        `Queued ${plannedAttempts.length} gated validation attempt(s) for analyst review and left ${triageQueueCount} weak hit(s) in triage-only status.`,
        'Blocked direct execution of downloaded PoC code; follow-up must use a separately reviewed low-impact validator or manual approval.',
      ],
      screenshots,
      validation: {
        candidateCount,
        rawCandidateCount,
        triageQueueCount,
        plannedAttemptCount: plannedAttempts.length,
        highestCandidateScore,
        fingerprintConfidence,
        fingerprintScore,
        productVersionPairCount,
        ownerConfirmedEvidenceCount,
        fingerprintCpes,
        fingerprintVendors,
        matchedCves,
        matchedCpes,
        matchedVendors,
        evidenceClass: candidateEvidenceClass,
        products,
        versions,
        arbitraryPocExecutionAllowed: false,
      },
    })
  const externalSearchFinding = buildExternalSearchFinding()
  const advisoryFinding = buildAdvisoryFinding()
  const validationGateFinding = buildValidationGateFinding()
  return [
    candidateFinding,
    ...(externalSearchFinding ? [externalSearchFinding] : []),
    ...(advisoryFinding ? [advisoryFinding] : []),
    ...(validationGateFinding ? [validationGateFinding] : []),
  ]
}

async function normalizeThreatTraceArtifact(
  context: NormalizationContext,
  addFinding: ReturnType<typeof findingFactory>,
): Promise<Finding[]> {
  const rawPath = join(context.runDir, 'raw', 'artifact-summary.json')
  const data = await readJsonIfExists<Record<string, unknown>>(rawPath)
  if (!data) return []

  const relativePath = projectPath(rawPath)
  const target = recordValue(data, 'target')
  const aggregate = recordValue(data, 'aggregate')
  const timestamps = recordValue(aggregate, 'timestamps')
  const artifactPath = stringValue(target, 'path') ?? targetLabel(context.run)
  const files = arrayValue(data, 'files')
  const fileCount =
    numberValue(aggregate, 'fileCount') ??
    (files.length > 0 ? files.length : undefined) ??
    0
  const totalBytes = numberValue(aggregate, 'totalBytes') ?? 0
  const scannedBytes = numberValue(aggregate, 'scannedBytes') ?? 0
  const indicatorCounts = numberRecord(aggregate?.indicatorCounts)
  const keywordHits = numberRecord(aggregate?.keywordHits)
  const structured = recordValue(aggregate, 'structured')
  const structuredParsers = numberRecord(structured?.parserCounts)
  const findings: Finding[] = []

  if (data.truncated === true) {
    context.warnings.push(
      `${relativePath} reached the artifact file limit; review raw scope and rerun with a narrower artifact path if needed.`,
    )
  }
  for (const warning of stringList(structured?.warnings)) {
    context.warnings.push(`${relativePath}: ${warning}`)
  }

  findings.push(
    addFinding({
      title: 'Threat trace artifact set indexed',
      severity: 'info',
      confidence: 'high',
      status: 'informational',
      category: 'threat-trace-artifact',
      target: artifactPath,
      sourceTool: 'redscope-internal-artifact-summary',
      evidence: [
        evidenceRef(context, relativePath, 'Artifact metadata summary', '/aggregate'),
      ],
      description: `RedScope indexed ${fileCount} local artifact file(s), totaling ${totalBytes} bytes, and scanned ${scannedBytes} bytes of text-compatible content for defensive triage metadata. Raw file contents and raw log lines were not copied into normalized findings.`,
      impact:
        'This establishes a local evidence inventory for incident analysis without making a vulnerability claim.',
      remediation:
        'Use the artifact inventory to decide which systems, identities, and time windows need containment or deeper forensic review.',
      references: [],
    }),
  )

  if (totalCount(indicatorCounts) > 0) {
    findings.push(
      addFinding({
        title: 'Indicators extracted for analyst triage',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-indicator',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Indicator count summary', '/aggregate/indicatorCounts'),
        ],
        description: `The artifact summary contains indicator counts by type: ${formatCounts(indicatorCounts)}. Capped indicator samples remain in the local raw summary for analyst review and are not expanded in this report narrative.`,
        impact:
          'Indicators can support scoping, blocking, enrichment, and timeline reconstruction, but they need analyst validation before attribution or containment decisions.',
        remediation:
          'Validate indicators against trusted telemetry, enrich them with internal context, and prioritize containment actions for confirmed malicious indicators.',
        references: [],
      }),
    )
  }

  if (totalCount(structuredParsers) > 0) {
    const csv = recordValue(structured, 'csv')
    const jsonEvents = recordValue(structured, 'jsonEvents')
    const stix = recordValue(structured, 'stix')
    const taxii = recordValue(structured, 'taxii')
    const zip = recordValue(structured, 'zip')
    const evtx = recordValue(structured, 'evtx')
    const pcap = recordValue(structured, 'pcap')
    const pe = recordValue(structured, 'pe')
    const registryHive = recordValue(structured, 'registryHive')
    const mailHeaders = recordValue(structured, 'mailHeaders')
    const caseManifests = recordValue(structured, 'caseManifests')
    const detailParts = [
      `parsers: ${formatCounts(structuredParsers)}`,
      numberValue(csv, 'rowCount')
        ? `csv rows: ${numberValue(csv, 'rowCount')}`
        : undefined,
      numberValue(jsonEvents, 'eventCount')
        ? `json events: ${numberValue(jsonEvents, 'eventCount')}`
        : undefined,
      numberValue(stix, 'objectCount')
        ? `stix objects: ${numberValue(stix, 'objectCount')}`
        : undefined,
      numberValue(taxii, 'collectionCount')
        ? `taxii collections: ${numberValue(taxii, 'collectionCount')}`
        : undefined,
      numberValue(zip, 'entryCount')
        ? `zip entries: ${numberValue(zip, 'entryCount')}`
        : undefined,
      numberValue(evtx, 'fileCount')
        ? `evtx files: ${numberValue(evtx, 'fileCount')}`
        : undefined,
      numberValue(evtx, 'eventRecordSampleCount')
        ? `evtx event records: ${numberValue(evtx, 'eventRecordSampleCount')}`
        : undefined,
      numberValue(pcap, 'fileCount')
        ? `pcap files: ${numberValue(pcap, 'fileCount')}`
        : undefined,
      numberValue(pe, 'fileCount')
        ? `pe files: ${numberValue(pe, 'fileCount')}`
        : undefined,
      numberValue(registryHive, 'fileCount')
        ? `registry hives: ${numberValue(registryHive, 'fileCount')}`
        : undefined,
      numberValue(mailHeaders, 'messageCount')
        ? `mail messages: ${numberValue(mailHeaders, 'messageCount')}`
        : undefined,
      numberValue(caseManifests, 'declaredArtifactCount')
        ? `case manifest artifacts: ${numberValue(caseManifests, 'declaredArtifactCount')}`
        : undefined,
    ].filter((part): part is string => typeof part === 'string')

    findings.push(
      addFinding({
        title: 'Structured incident artifact formats summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-structured-artifact',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Structured parser summary', '/aggregate/structured'),
        ],
        description: `RedScope detected structured artifact formats and generated parser-level metadata (${detailParts.join('; ')}). The summary stores counts, field names, and bounded metadata only; raw rows, event bodies, archive contents, EVTX records, executable contents, and registry cell contents are not copied into the report.`,
        impact:
          'Structured summaries help analysts separate SIEM exports, STIX intelligence, case manifests, EVTX files, PE files, registry hives, and archive bundles before deeper forensic review.',
        remediation:
          'Review parser-specific counts in the local raw summary, then prioritize enrichment or forensic tooling for the highest-value structured evidence source.',
        references: [],
      }),
    )
  }

  const evtx = recordValue(structured, 'evtx')
  const evtxFileCount = numberValue(evtx, 'fileCount') ?? 0
  if (evtxFileCount > 0) {
    const declaredChunkCount = numberValue(evtx, 'declaredChunkCount') ?? 0
    const detectedChunkHeaderCount =
      numberValue(evtx, 'detectedChunkHeaderCount') ?? 0
    const chunkHeaderSampleCount =
      numberValue(evtx, 'chunkHeaderSampleCount') ?? 0
    const versionCounts = numberRecord(recordValue(evtx, 'versionCounts'))
    const eventRecordSampleCount =
      numberValue(evtx, 'eventRecordSampleCount') ?? 0
    const eventRecordTimestampCount =
      numberValue(evtx, 'eventRecordTimestampCount') ?? 0
    const eventRecordSizeMin = numberValue(evtx, 'eventRecordSizeMin')
    const eventRecordSizeMax = numberValue(evtx, 'eventRecordSizeMax')
    const eventRecordIdentifierFirst = stringValue(
      evtx,
      'eventRecordIdentifierFirst',
    )
    const eventRecordIdentifierLast = stringValue(
      evtx,
      'eventRecordIdentifierLast',
    )
    const eventRecordTimeFirst = stringValue(evtx, 'eventRecordTimeFirst')
    const eventRecordTimeLast = stringValue(evtx, 'eventRecordTimeLast')
    const eventRecordSizeMismatchCount =
      numberValue(evtx, 'eventRecordSizeMismatchCount') ?? 0
    const eventRecordTruncatedCount =
      numberValue(evtx, 'eventRecordTruncatedCount') ?? 0
    const chunkWithEventRecordsCount =
      numberValue(evtx, 'chunkWithEventRecordsCount') ?? 0
    const binXmlTemplateInstanceCount =
      numberValue(evtx, 'binXmlTemplateInstanceCount') ?? 0
    const binXmlNormalSubstitutionCount =
      numberValue(evtx, 'binXmlNormalSubstitutionCount') ?? 0
    const binXmlOptionalSubstitutionCount =
      numberValue(evtx, 'binXmlOptionalSubstitutionCount') ?? 0
    const binXmlFragmentHeaderCount =
      numberValue(evtx, 'binXmlFragmentHeaderCount') ?? 0
    const binXmlScanBytes = numberValue(evtx, 'binXmlScanBytes') ?? 0
    const eventRecordDetails = [
      eventRecordSampleCount > 0
        ? `sampled ${eventRecordSampleCount} event record header(s)`
        : undefined,
      eventRecordTimestampCount > 0
        ? `timestamped records: ${eventRecordTimestampCount}`
        : undefined,
      eventRecordSizeMin != null && eventRecordSizeMax != null
        ? `record size range: ${eventRecordSizeMin}-${eventRecordSizeMax} bytes`
        : undefined,
      eventRecordIdentifierFirst && eventRecordIdentifierLast
        ? `record identifiers: ${eventRecordIdentifierFirst}-${eventRecordIdentifierLast}`
        : undefined,
      eventRecordTimeFirst && eventRecordTimeLast
        ? `record time range: ${eventRecordTimeFirst} to ${eventRecordTimeLast}`
        : undefined,
      chunkWithEventRecordsCount > 0
        ? `chunks with records: ${chunkWithEventRecordsCount}`
        : undefined,
      eventRecordSizeMismatchCount > 0
        ? `size mismatches: ${eventRecordSizeMismatchCount}`
        : undefined,
      eventRecordTruncatedCount > 0
        ? `truncated records: ${eventRecordTruncatedCount}`
        : undefined,
      binXmlScanBytes > 0
        ? `BinXML metadata bytes scanned: ${binXmlScanBytes}`
        : undefined,
      binXmlTemplateInstanceCount > 0
        ? `template instances: ${binXmlTemplateInstanceCount}`
        : undefined,
      binXmlNormalSubstitutionCount > 0
        ? `normal substitutions: ${binXmlNormalSubstitutionCount}`
        : undefined,
      binXmlOptionalSubstitutionCount > 0
        ? `optional substitutions: ${binXmlOptionalSubstitutionCount}`
        : undefined,
      binXmlFragmentHeaderCount > 0
        ? `fragment headers: ${binXmlFragmentHeaderCount}`
        : undefined,
    ].filter((part): part is string => typeof part === 'string')
    findings.push(
      addFinding({
        title: 'EVTX file and event-record metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-evtx-metadata',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'EVTX metadata summary', '/aggregate/structured/evtx'),
        ],
        description: `RedScope summarized ${evtxFileCount} EVTX file(s), declared chunk count ${declaredChunkCount}, sampled ${chunkHeaderSampleCount} chunk header(s), and detected ${detectedChunkHeaderCount} EVTX chunk header(s). Version counts: ${formatCounts(versionCounts)}.${eventRecordDetails.length > 0 ? ` Event-record and bounded BinXML metadata: ${eventRecordDetails.join('; ')}.` : ''} EVTX BinXML event bodies are not decoded or copied into the report.`,
        impact:
          'EVTX header and event-record metadata helps analysts confirm evidence shape, estimate event-log scope, and bound record time ranges before opening records in approved forensic tooling.',
        remediation:
          'Review the EVTX file in a trusted Windows event log or forensic parser, then correlate sampled record identifiers and time ranges with endpoint telemetry.',
        references: [],
      }),
    )
  }

  const zip = recordValue(structured, 'zip')
  const traversalCount = numberValue(zip, 'pathTraversalEntryCount') ?? 0
  const encryptedCount = numberValue(zip, 'encryptedEntryCount') ?? 0
  if (traversalCount > 0 || encryptedCount > 0) {
    const observations = [
      traversalCount > 0 ? `path traversal-style entries: ${traversalCount}` : undefined,
      encryptedCount > 0 ? `encrypted entries: ${encryptedCount}` : undefined,
    ].filter((part): part is string => typeof part === 'string')

    findings.push(
      addFinding({
        title: 'Archive bundle needs controlled handling',
        severity: 'low',
        confidence: 'medium',
        status: 'suspected',
        category: 'threat-trace-archive-warning',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'ZIP manifest summary', '/aggregate/structured/zip'),
        ],
        description: `The artifact archive summary reported ${observations.join(', ')}. RedScope did not extract the archive or copy entry contents.`,
        impact:
          'Archive metadata may indicate packaging risk for analyst workstations or missing visibility into encrypted evidence.',
        remediation:
          'Handle the archive in a controlled forensic workspace, verify provenance, and extract only after confirming the bundle is expected and authorized.',
        references: [],
      }),
    )
  }

  const pcap = recordValue(structured, 'pcap')
  const pcapFileCount = numberValue(pcap, 'fileCount') ?? 0
  if (pcapFileCount > 0) {
    const parsedPacketCount = numberValue(pcap, 'parsedPacketCount') ?? 0
    const transportProtocolCounts = numberRecord(
      recordValue(pcap, 'transportProtocolCounts'),
    )
    const portCounts = numberRecord(recordValue(pcap, 'portCounts'))
    const tcpFlagCounts = numberRecord(recordValue(pcap, 'tcpFlagCounts'))
    const pcapngSectionCount = numberValue(pcap, 'pcapngSectionCount') ?? 0
    const pcapngInterfaceCount = numberValue(pcap, 'pcapngInterfaceCount') ?? 0
    const pcapngEnhancedPacketBlockCount =
      numberValue(pcap, 'pcapngEnhancedPacketBlockCount') ?? 0
    const pcapngSimplePacketBlockCount =
      numberValue(pcap, 'pcapngSimplePacketBlockCount') ?? 0
    const pcapngBlockTypeCounts = numberRecord(
      recordValue(pcap, 'pcapngBlockTypeCounts'),
    )
    const pcapngTimestampResolutionCounts = numberRecord(
      recordValue(pcap, 'pcapngTimestampResolutionCounts'),
    )
    const pcapngSummary =
      pcapngSectionCount > 0
        ? ` PCAPNG block metadata includes sections: ${pcapngSectionCount}, interfaces: ${pcapngInterfaceCount}, enhanced packet blocks: ${pcapngEnhancedPacketBlockCount}, simple packet blocks: ${pcapngSimplePacketBlockCount}, block types (${formatCounts(pcapngBlockTypeCounts)}), and timestamp resolutions (${formatCounts(pcapngTimestampResolutionCounts)}).`
        : ''
    const flowSummary =
      parsedPacketCount > 0
        ? ` RedScope parsed ${parsedPacketCount} supported network/transport header(s), with transport protocols (${formatCounts(transportProtocolCounts)}), observed ports (${formatCounts(portCounts)}), and TCP flags (${formatCounts(tcpFlagCounts)}). Flow samples are stored only as anonymous hashes.`
        : ''
    findings.push(
      addFinding({
        title: 'Network capture metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-network-capture',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'PCAP metadata summary', '/aggregate/structured/pcap'),
        ],
        description: `RedScope identified ${pcapFileCount} packet capture file(s) and sampled ${numberValue(pcap, 'packetHeaderSampleCount') ?? 0} packet header(s).${pcapngSummary}${flowSummary} Packet payloads and raw endpoint addresses are not decoded or copied into the report.`,
        impact:
          'Packet capture metadata helps analysts prioritize network forensic review without exposing raw payloads in normalized deliverables.',
        remediation:
          'Open the capture only in an approved forensic workstation, confirm capture time bounds, and correlate with firewall, proxy, DNS, and endpoint telemetry.',
        references: [],
      }),
    )
  }

  const pe = recordValue(structured, 'pe')
  const peFileCount = numberValue(pe, 'fileCount') ?? 0
  if (peFileCount > 0) {
    const machineCounts = numberRecord(recordValue(pe, 'machineCounts'))
    const subsystemCounts = numberRecord(recordValue(pe, 'subsystemCounts'))
    const characteristicCounts = numberRecord(
      recordValue(pe, 'characteristicCounts'),
    )
    const dllCharacteristicCounts = numberRecord(
      recordValue(pe, 'dllCharacteristicCounts'),
    )
    const sectionCharacteristicCounts = numberRecord(
      recordValue(pe, 'sectionCharacteristicCounts'),
    )
    const warningCounts = numberRecord(recordValue(pe, 'warningCounts'))
    const details = [
      `machines: ${formatCounts(machineCounts)}`,
      `subsystems: ${formatCounts(subsystemCounts)}`,
      `sections: ${numberValue(pe, 'sectionCount') ?? 0}`,
      `executable sections: ${numberValue(pe, 'executableSectionCount') ?? 0}`,
      `writable sections: ${numberValue(pe, 'writableSectionCount') ?? 0}`,
      `imports present: ${numberValue(pe, 'importDirectoryCount') ?? 0}`,
      `certificate tables present: ${numberValue(pe, 'certificateTableCount') ?? 0}`,
      totalCount(characteristicCounts) > 0
        ? `COFF characteristics: ${formatCounts(characteristicCounts)}`
        : undefined,
      totalCount(dllCharacteristicCounts) > 0
        ? `DLL characteristics: ${formatCounts(dllCharacteristicCounts)}`
        : undefined,
      totalCount(sectionCharacteristicCounts) > 0
        ? `section characteristics: ${formatCounts(sectionCharacteristicCounts)}`
        : undefined,
      totalCount(warningCounts) > 0
        ? `warnings: ${formatCounts(warningCounts)}`
        : undefined,
    ].filter((part): part is string => typeof part === 'string')
    findings.push(
      addFinding({
        title: 'PE executable metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-pe-metadata',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'PE metadata summary', '/aggregate/structured/pe'),
        ],
        description: `RedScope summarized ${peFileCount} PE file(s) with bounded header and section metadata (${details.join('; ')}). Raw executable bytes, import names, section names, resources, strings, and code are not copied into the report.`,
        impact:
          'PE metadata can help analysts prioritize suspicious binaries for controlled malware or software-inventory review without exposing file contents in normalized deliverables.',
        remediation:
          'Open binaries only in an approved malware-analysis or software-inventory environment, then correlate hashes, signer/certificate context, host telemetry, and execution evidence.',
        references: [],
      }),
    )
  }

  const registryHive = recordValue(structured, 'registryHive')
  const registryHiveFileCount = numberValue(registryHive, 'fileCount') ?? 0
  if (registryHiveFileCount > 0) {
    const versionCounts = numberRecord(recordValue(registryHive, 'versionCounts'))
    const typeCounts = numberRecord(recordValue(registryHive, 'typeCounts'))
    const formatCountsValue = numberRecord(
      recordValue(registryHive, 'formatCounts'),
    )
    const warningCounts = numberRecord(recordValue(registryHive, 'warningCounts'))
    const details = [
      `versions: ${formatCounts(versionCounts)}`,
      `types: ${formatCounts(typeCounts)}`,
      `formats: ${formatCounts(formatCountsValue)}`,
      `hbin headers: ${numberValue(registryHive, 'hbinHeaderCount') ?? 0}`,
      `hbin bytes: ${numberValue(registryHive, 'hbinSizeBytes') ?? 0}`,
      `sequence mismatches: ${numberValue(registryHive, 'sequenceMismatchCount') ?? 0}`,
      stringValue(registryHive, 'lastWrittenFirst') &&
      stringValue(registryHive, 'lastWrittenLast')
        ? `last-written range: ${stringValue(registryHive, 'lastWrittenFirst')} to ${stringValue(registryHive, 'lastWrittenLast')}`
        : undefined,
      totalCount(warningCounts) > 0
        ? `warnings: ${formatCounts(warningCounts)}`
        : undefined,
    ].filter((part): part is string => typeof part === 'string')
    findings.push(
      addFinding({
        title: 'Registry hive metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-registry-hive',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Registry hive metadata summary', '/aggregate/structured/registryHive'),
        ],
        description: `RedScope summarized ${registryHiveFileCount} registry hive file(s) with base-block and hbin layout metadata (${details.join('; ')}). Raw key names, values, security descriptors, and registry cell contents are not decoded or copied into the report.`,
        impact:
          'Registry hive metadata helps analysts identify candidate Windows forensic artifacts and bound hive timestamps before opening sensitive registry contents.',
        remediation:
          'Review hives only in an approved forensic parser, then correlate last-written ranges and hive provenance with endpoint timeline evidence.',
        references: [],
      }),
    )
  }

  const mailHeaders = recordValue(structured, 'mailHeaders')
  const mailMessageCount = numberValue(mailHeaders, 'messageCount') ?? 0
  if (mailMessageCount > 0) {
    const attachmentPartCount = numberValue(mailHeaders, 'attachmentPartCount') ?? 0
    const attachmentContentTypeCounts = numberRecord(
      recordValue(mailHeaders, 'attachmentContentTypeCounts'),
    )
    const attachmentExtensionCounts = numberRecord(
      recordValue(mailHeaders, 'attachmentExtensionCounts'),
    )
    const attachmentDispositionCounts = numberRecord(
      recordValue(mailHeaders, 'attachmentDispositionCounts'),
    )
    const attachmentSummary =
      attachmentPartCount > 0
        ? ` Attachment metadata includes ${attachmentPartCount} attachment part(s), dispositions (${formatCounts(attachmentDispositionCounts)}), content types (${formatCounts(attachmentContentTypeCounts)}), and filename extensions (${formatCounts(attachmentExtensionCounts)}). Attachment filenames and bodies are not copied into the report.`
        : ''
    findings.push(
      addFinding({
        title: 'Mail header metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-mail-header',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Mail header summary', '/aggregate/structured/mailHeaders'),
        ],
        description: `RedScope summarized headers for ${mailMessageCount} message(s), including sender and recipient domain counts, received-hop counts, authentication-result presence, and attachment metadata counts.${attachmentSummary} Message bodies and raw header values are not copied into the report.`,
        impact:
          'Mail header metadata can support phishing, business email compromise, and spoofing triage while limiting sensitive message exposure.',
        remediation:
          'Validate sender domains, authentication results, and received-hop anomalies in the mail security gateway before containment or user notification.',
        references: [],
      }),
    )
  }

  const taxii = recordValue(structured, 'taxii')
  const taxiiCollectionCount = numberValue(taxii, 'collectionCount') ?? 0
  if (taxiiCollectionCount > 0) {
    findings.push(
      addFinding({
        title: 'TAXII collection metadata summarized',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-taxii',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'TAXII metadata summary', '/aggregate/structured/taxii'),
        ],
        description: `RedScope summarized TAXII-style metadata for ${taxiiCollectionCount} collection(s). It records collection counts, API root counts, pagination hints, and media-type counts only.`,
        impact:
          'TAXII metadata helps analysts understand threat-intelligence source shape before importing indicators or STIX bundles.',
        remediation:
          'Review collection provenance, intended sharing group, and media type compatibility before syncing indicators into production controls.',
        references: [],
      }),
    )
  }

  const caseManifests = recordValue(structured, 'caseManifests')
  const caseValidationWarnings = numberRecord(
    caseManifests?.validationWarningCounts,
  )
  if (totalCount(caseValidationWarnings) > 0) {
    const declaredArtifactCount =
      numberValue(caseManifests, 'declaredArtifactCount') ?? 0
    const evidenceWithStableIdCount =
      numberValue(caseManifests, 'evidenceWithStableIdCount') ?? 0
    const evidenceWithPathCount =
      numberValue(caseManifests, 'evidenceWithPathCount') ?? 0
    const evidenceWithHashCount =
      numberValue(caseManifests, 'evidenceWithHashCount') ?? 0
    const evidenceWithTimestampCount =
      numberValue(caseManifests, 'evidenceWithTimestampCount') ?? 0
    const evidenceWithSourceCount =
      numberValue(caseManifests, 'evidenceWithSourceCount') ?? 0
    const evidenceWithCustodianCount =
      numberValue(caseManifests, 'evidenceWithCustodianCount') ?? 0
    const duplicateEvidenceIdCount =
      numberValue(caseManifests, 'duplicateEvidenceIdCount') ?? 0
    const pathReferenceNotes =
      duplicateEvidenceIdCount > 0
        ? ` Duplicate evidence identifiers: ${duplicateEvidenceIdCount}.`
        : ''
    findings.push(
      addFinding({
        title: 'Case manifest validation gaps observed',
        severity: 'low',
        confidence: 'medium',
        status: 'suspected',
        category: 'threat-trace-case-manifest',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Case manifest validation summary', '/aggregate/structured/caseManifests/validationWarningCounts'),
        ],
        description: `Case manifest metadata reported validation gaps: ${formatCounts(caseValidationWarnings)}. Declared evidence records: ${declaredArtifactCount}; records with stable IDs: ${evidenceWithStableIdCount}; paths: ${evidenceWithPathCount}; hashes: ${evidenceWithHashCount}; timestamps: ${evidenceWithTimestampCount}; sources: ${evidenceWithSourceCount}; custodians: ${evidenceWithCustodianCount}.${pathReferenceNotes} RedScope did not copy raw evidence records or artifact contents into the report.`,
        impact:
          'Incomplete case metadata can slow review, weaken chain-of-custody confidence, or make scope verification harder during handoff.',
        remediation:
          'Update the case manifest with stable evidence identifiers, hashes or paths, chain-of-custody metadata, and explicit scope or authorization references.',
        references: [],
      }),
    )
  }

  if (totalCount(keywordHits) > 0) {
    findings.push(
      addFinding({
        title: 'Security-relevant event keywords observed',
        severity: 'low',
        confidence: 'low',
        status: 'suspected',
        category: 'threat-trace-keyword',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Keyword hit summary', '/aggregate/keywordHits'),
        ],
        description: `RedScope observed security-relevant keyword groups in the artifact text: ${formatCounts(keywordHits)}. Keyword hits are weak signals and should be treated as triage leads, not confirmed incident facts.`,
        impact:
          'These keyword groups may point to authentication failures, access denials, malware terms, privilege changes, or possible exfiltration language that deserves manual review.',
        remediation:
          'Review the underlying local artifacts around the referenced time window and correlate with endpoint, identity, network, and cloud telemetry.',
        references: [],
      }),
    )
  }

  const timestampCount = numberValue(timestamps, 'count') ?? 0
  if (timestampCount > 0) {
    const first = stringValue(timestamps, 'first') ?? 'unknown'
    const last = stringValue(timestamps, 'last') ?? 'unknown'
    findings.push(
      addFinding({
        title: 'Artifact timeline bounds identified',
        severity: 'info',
        confidence: 'medium',
        status: 'informational',
        category: 'threat-trace-timeline',
        target: artifactPath,
        sourceTool: 'redscope-internal-artifact-summary',
        evidence: [
          evidenceRef(context, relativePath, 'Timestamp bounds summary', '/aggregate/timestamps'),
        ],
        description: `RedScope parsed ${timestampCount} timestamp-like values from text-compatible artifacts. Observed bounds: ${first} to ${last}.`,
        impact:
          'Timeline bounds help anchor containment review and identify telemetry gaps, but parsed timestamps may include unrelated log or metadata values.',
        remediation:
          'Confirm the time zone, normalize timestamps to the incident timeline, and correlate with higher-confidence telemetry before drawing conclusions.',
        references: [],
      }),
    )
  }

  return findings
}

function commandLimitations(commands: CommandManifest[], run: RunManifest): string[] {
  const limitations: string[] = []
  if (run.status !== 'executed') {
    limitations.push(
      'The source run was not executed; the report may contain only planning artifacts and available raw files.',
    )
  }
  for (const command of commands) {
    if (command.status === 'skipped') {
      limitations.push(
        `${command.stepId ?? 'unknown-step'} was skipped${command.reason ? `: ${command.reason}` : ''}.`,
      )
    }
    if (command.status === 'failed') {
      limitations.push(
        `${command.stepId ?? 'unknown-step'} failed${command.exitCode != null ? ` with exit code ${command.exitCode}` : ''}${command.reason ? `: ${command.reason}` : ''}.`,
      )
    }
    if (command.status === 'planned') {
      limitations.push(
        `${command.stepId ?? 'unknown-step'} was planned but not executed.`,
      )
    }
  }
  return [...new Set(limitations)]
}

function summarizeFindings(findings: Finding[]): FindingBundle['summary'] {
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  }
  const byStatus: Record<FindingStatus, number> = {
    confirmed: 0,
    suspected: 0,
    informational: 0,
  }
  const byEvidenceClass: Record<EvidenceClass, number> = {
    'public-intelligence-lead': 0,
    'target-fingerprint-correlation': 0,
    'owner-confirmed-target-version': 0,
    'target-verified-issue': 0,
  }

  let highest: Severity | 'none' = 'none'
  for (const finding of findings) {
    bySeverity[finding.severity]++
    byStatus[finding.status]++
    if (finding.evidenceClass) byEvidenceClass[finding.evidenceClass]++
    if (
      highest === 'none' ||
      severityRank(finding.severity) > severityRank(highest)
    ) {
      highest = finding.severity
    }
  }

  return {
    total: findings.length,
    highestSeverity: highest,
    bySeverity,
    byStatus,
    byEvidenceClass,
  }
}

async function normalizeRun(runDir: string): Promise<{
  bundle: FindingBundle
  evidenceIndex: EvidenceIndex
  report: string
}> {
  const run = await readJsonFile<RunManifest>(join(runDir, 'run.json'))
  const commands =
    (await readJsonIfExists<CommandManifest[]>(join(runDir, 'command-manifest.json'))) ?? []
  const evidence = await collectEvidence(runDir)
  const context: NormalizationContext = {
    runDir,
    run,
    commands,
    evidence,
    warnings: [],
  }
  const addFinding = findingFactory(run.profile?.id)
  const rawFindings = [
    ...(await normalizeBaseline(context, addFinding)),
    ...(await normalizeGitleaks(context, addFinding)),
    ...(await normalizeSemgrep(context, addFinding)),
    ...(await normalizeHttpx(context, addFinding)),
    ...(await normalizeNuclei(context, addFinding)),
    ...(await normalizeLowImpactValidation(context, addFinding)),
    ...(await normalizeBusinessLogicValidation(context, addFinding)),
    ...(await normalizePocValidationPlan(context, addFinding)),
    ...(await normalizeThreatTraceArtifact(context, addFinding)),
  ]
  const screenshotRefs = screenshotEvidenceRefs(context)
  const findings = rawFindings.map(finding => ({
    ...finding,
    testProcess: finding.testProcess ?? defaultTestProcess(finding.sourceTool),
    screenshots: finding.screenshots ?? screenshotRefs,
  }))
  const limitations = commandLimitations(commands, run)

  const bundle: FindingBundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      runDir: projectPath(runDir),
      runGeneratedAt: run.generatedAt,
      runStatus: run.status,
      profile: {
        id: run.profile?.id,
        name: run.profile?.name,
        riskLevel: run.profile?.riskLevel,
        reportTemplate: run.profile?.reportTemplate,
      },
      target: targetLabel(run),
      authorization: run.authorization,
    },
    summary: summarizeFindings(findings),
    findings,
    limitations,
    warnings: context.warnings,
  }

  const evidenceIndex: EvidenceIndex = {
    schemaVersion: 1,
    generatedAt: bundle.generatedAt,
    runDir: projectPath(runDir),
    evidence,
    notes: [
      'Evidence hashes are SHA-256 digests of the files present when the report pipeline ran.',
      'Normalized findings avoid copying raw secrets, payloads, or response bodies into the report.',
    ],
  }

  return {
    bundle,
    evidenceIndex,
    report: renderReport(bundle, evidenceIndex, commands),
  }
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderCounts(summary: FindingBundle['summary']): string {
  return [
    `Total findings: ${summary.total}`,
    `Highest severity: ${summary.highestSeverity}`,
    `Critical: ${summary.bySeverity.critical}`,
    `High: ${summary.bySeverity.high}`,
    `Medium: ${summary.bySeverity.medium}`,
    `Low: ${summary.bySeverity.low}`,
    `Info: ${summary.bySeverity.info}`,
    `Public intelligence leads: ${summary.byEvidenceClass['public-intelligence-lead']}`,
    `Target fingerprint correlations: ${summary.byEvidenceClass['target-fingerprint-correlation']}`,
    `Owner-confirmed target versions: ${summary.byEvidenceClass['owner-confirmed-target-version']}`,
    `Target-verified issues: ${summary.byEvidenceClass['target-verified-issue']}`,
  ].join('\n')
}

function renderFindingsTable(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'No confirmed, suspected, or informational findings were normalized from the available run artifacts.'
  }

  const rows = [
    '| ID | Severity | Confidence | Status | Evidence Class | Title | Target |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const finding of findings) {
    rows.push(
      `| ${finding.id} | ${finding.severity} | ${finding.confidence} | ${finding.status} | ${finding.evidenceClass ?? 'not-classified'} | ${mdEscape(finding.title)} | ${mdEscape(finding.target)} |`,
    )
  }
  return rows.join('\n')
}

function renderFindingDetails(findings: Finding[]): string {
  if (findings.length === 0) return 'No detailed findings were generated.'

  return findings
    .map(finding => {
      const evidence = finding.evidence
        .map(item => {
          const locator = item.jsonPointer
            ? ` ${item.jsonPointer}`
            : item.line
              ? ` line ${item.line}`
              : ''
          return `- ${item.id}: \`${item.path}\`${locator} - ${item.description}`
        })
        .join('\n')
      const references =
        finding.references.length > 0
          ? finding.references.map(item => `- ${item}`).join('\n')
          : '- None recorded'
      const testProcess =
        finding.testProcess && finding.testProcess.length > 0
          ? finding.testProcess.map(item => `- ${item}`).join('\n')
          : defaultTestProcess(finding.sourceTool)
              .map(item => `- ${item}`)
              .join('\n')
      const screenshots =
        finding.screenshots && finding.screenshots.length > 0
          ? finding.screenshots
              .map(item => `- ${item.id}: \`${item.path}\` - ${item.description}`)
              .join('\n')
          : '- No screenshot evidence attached to this finding.'
      return [
        `### ${finding.id} - ${finding.title}`,
        '',
        `Severity: \`${finding.severity}\``,
        `Confidence: \`${finding.confidence}\``,
        `Status: \`${finding.status}\``,
        `Category: \`${finding.category}\``,
        `Evidence class: \`${finding.evidenceClass ?? 'not-classified'}\``,
        `Source: \`${finding.sourceTool}\``,
        `Target: \`${finding.target}\``,
        '',
        finding.description,
        '',
        `Impact: ${finding.impact}`,
        '',
        `Remediation: ${finding.remediation}`,
        '',
        'Test Process:',
        testProcess,
        '',
        'Evidence:',
        evidence,
        '',
        'Screenshots:',
        screenshots,
        '',
        'References:',
        references,
      ].join('\n')
    })
    .join('\n\n')
}

function renderEvidenceIndex(evidenceIndex: EvidenceIndex): string {
  if (evidenceIndex.evidence.length === 0) return 'No evidence files were indexed.'
  return evidenceIndex.evidence
    .map(
      item =>
        `- ${item.id}: \`${item.path}\` (${item.kind}, ${item.bytes} bytes, sha256 ${item.sha256})`,
    )
    .join('\n')
}

function renderCommandSummary(commands: CommandManifest[]): string {
  if (commands.length === 0) return 'No command manifest was available.'
  return commands
    .map(command => {
      const status = command.status ?? 'unknown'
      const step = command.stepId ?? 'unknown-step'
      const tool = command.tool ? `, tool ${command.tool}` : ''
      const reason = command.reason ? ` - ${command.reason}` : ''
      return `- ${step}: ${status}${tool}${reason}`
    })
    .join('\n')
}

function renderReport(
  bundle: FindingBundle,
  evidenceIndex: EvidenceIndex,
  commands: CommandManifest[],
): string {
  const authorization = bundle.source.authorization
  const limitations =
    bundle.limitations.length > 0
      ? bundle.limitations.map(item => `- ${item}`).join('\n')
      : '- No additional limitations were recorded by the pipeline.'
  const warnings =
    bundle.warnings.length > 0
      ? bundle.warnings.map(item => `- ${item}`).join('\n')
      : '- No parser warnings.'

  return `${[
    `# RedScope ${bundle.source.profile.name ?? 'Security'} Report`,
    '',
    '## Executive Summary',
    '',
    renderCounts(bundle.summary),
    '',
    '## Scope and Authorization',
    '',
    `Profile: \`${bundle.source.profile.id ?? 'unknown'}\``,
    `Risk level: \`${bundle.source.profile.riskLevel ?? 'unknown'}\``,
    `Target: \`${bundle.source.target}\``,
    `Run directory: \`${bundle.source.runDir}\``,
    `Run status: \`${bundle.source.runStatus ?? 'unknown'}\``,
    `Scope owner: \`${authorization?.owner ?? 'unknown'}\``,
    `Authorized by: \`${authorization?.authorizedBy ?? 'unknown'}\``,
    `Authorization reference: \`${authorization?.reference ?? 'none'}\``,
    `Authorization window: \`${authorization?.validFrom ?? 'unknown'}\` to \`${authorization?.validTo ?? 'unknown'}\``,
    '',
    '## Methodology',
    '',
    renderCommandSummary(commands),
    '',
    '## Findings Table',
    '',
    renderFindingsTable(bundle.findings),
    '',
    '## Detailed Findings',
    '',
    renderFindingDetails(bundle.findings),
    '',
    '## Evidence Index',
    '',
    renderEvidenceIndex(evidenceIndex),
    '',
    '## Limitations and Next Steps',
    '',
    limitations,
    '',
    'Parser warnings:',
    warnings,
    '',
    'Recommended next steps:',
    '- Review suspected findings with the system owner before treating them as confirmed vulnerabilities.',
    '- Keep public-intelligence-lead items separate from target-verified issues; promote only after owner-confirmed version evidence and approved low-impact validation.',
    '- Keep all follow-up testing inside the same written authorization and profile boundaries.',
    '- Rotate exposed secrets immediately if any secret-scanning finding is confirmed.',
  ].join('\n')}\n`
}

async function findLatestRun(outputRoot: string, profileId: string): Promise<string> {
  const profileRoot = resolve(outputRoot, profileId)
  assertInside(profileRoot, outputRoot, 'profile output root')
  if (!(await pathExists(profileRoot))) {
    throw new Error(`${projectPath(profileRoot)} does not exist`)
  }

  const entries = await readdir(profileRoot, { withFileTypes: true })
  const candidates: Array<{ path: string; generatedAt: number; mtime: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = join(profileRoot, entry.name)
    const runPath = join(runDir, 'run.json')
    if (!(await pathExists(runPath))) continue
    let generatedAt = 0
    try {
      const run = await readJsonFile<RunManifest>(runPath)
      generatedAt = Date.parse(run.generatedAt ?? '')
      if (!Number.isFinite(generatedAt)) generatedAt = 0
    } catch {
      generatedAt = 0
    }
    const info = await stat(runDir)
    candidates.push({ path: runDir, generatedAt, mtime: info.mtimeMs })
  }

  candidates.sort((a, b) => {
    if (b.generatedAt !== a.generatedAt) return b.generatedAt - a.generatedAt
    return b.mtime - a.mtime
  })

  const latest = candidates[0]?.path
  if (!latest) throw new Error(`no runs found under ${projectPath(profileRoot)}`)
  return latest
}

async function resolveRunDir(options: Options): Promise<string> {
  const outputRoot = resolveProjectPath(options.outputRoot)
  assertInside(outputRoot, repoRoot, 'output root')

  if (options.runPath) {
    const runDir = resolveProjectPath(options.runPath)
    assertInside(runDir, outputRoot, 'run directory')
    return runDir
  }

  if (options.latest) {
    if (!options.profileId) usage()
    return findLatestRun(outputRoot, options.profileId)
  }

  usage()
}

async function runReport(options: Options) {
  const runDir = await resolveRunDir(options)
  if (!(await pathExists(join(runDir, 'run.json')))) {
    throw new Error(`${projectPath(runDir)} is missing run.json`)
  }

  const normalized = await normalizeRun(runDir)
  const manifest = {
    schemaVersion: 1,
    generatedAt: normalized.bundle.generatedAt,
    runDir: projectPath(runDir),
    generatedFiles: {
      findings: projectPath(join(runDir, 'findings.json')),
      evidenceIndex: projectPath(join(runDir, 'evidence-index.json')),
      report: projectPath(join(runDir, 'report.md')),
      reportManifest: projectPath(join(runDir, 'report-manifest.json')),
    },
    summary: normalized.bundle.summary,
    warnings: normalized.bundle.warnings,
  }

  if (!options.dryRun) {
    await writeJson(join(runDir, 'findings.json'), normalized.bundle)
    await writeJson(join(runDir, 'evidence-index.json'), normalized.evidenceIndex)
    await writeText(join(runDir, 'report.md'), normalized.report)
    await writeJson(join(runDir, 'report-manifest.json'), manifest)
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          ...manifest,
          findings: normalized.bundle.findings,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`${options.dryRun ? 'Prepared' : 'Wrote'} RedScope report`)
  console.log(`  run: ${projectPath(runDir)}`)
  console.log(`  findings: ${normalized.bundle.summary.total}`)
  console.log(`  highest severity: ${normalized.bundle.summary.highestSeverity}`)
  if (!options.dryRun) {
    console.log(`  report: ${projectPath(join(runDir, 'report.md'))}`)
    console.log(`  findings JSON: ${projectPath(join(runDir, 'findings.json'))}`)
    console.log(`  evidence index: ${projectPath(join(runDir, 'evidence-index.json'))}`)
  }
}

runReport(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-report-pipeline: ${error.message}`)
  process.exit(1)
})
