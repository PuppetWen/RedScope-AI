#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  appendFile,
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

type DeliveryStatus =
  | 'draft'
  | 'ready-for-review'
  | 'approved'
  | 'needs-changes'

type TriageStatus =
  | 'needs-review'
  | 'informational'
  | 'accepted-risk'
  | 'false-positive'
  | 'fixed'
  | 'deferred'

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
type FindingStatus = 'confirmed' | 'suspected' | 'informational'

type Options = {
  runPath?: string
  latest: boolean
  profileId?: string
  outputRoot: string
  status: DeliveryStatus
  reviewer?: string
  note?: string
  dryRun: boolean
  json: boolean
  force: boolean
  skipHtml: boolean
  pdf: boolean
  triageFile?: string
  tracePath?: string
}

type RunManifest = {
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
}

type EvidenceReference = {
  id?: string
  path?: string
  description?: string
  jsonPointer?: string
  line?: number
}

type Finding = {
  id?: string
  title?: string
  severity?: Severity
  confidence?: string
  status?: FindingStatus
  category?: string
  target?: string
  sourceTool?: string
  evidence?: EvidenceReference[]
}

type FindingSummary = {
  total?: number
  highestSeverity?: Severity | 'none'
  bySeverity?: Partial<Record<Severity, number>>
  byStatus?: Partial<Record<FindingStatus, number>>
}

type FindingBundle = {
  generatedAt?: string
  source?: {
    runDir?: string
    runStatus?: string
    profile?: RunManifest['profile']
    target?: string
    authorization?: RunManifest['authorization']
  }
  summary?: FindingSummary
  findings?: Finding[]
  limitations?: string[]
  warnings?: string[]
}

type EvidenceIndex = {
  evidence?: Array<{
    id?: string
    kind?: string
    path?: string
    description?: string
    sha256?: string
    bytes?: number
  }>
}

type TriageFinding = {
  id: string
  title: string
  severity: Severity | 'unknown'
  reportStatus: FindingStatus | 'unknown'
  confidence: string
  category: string
  target: string
  triageStatus: TriageStatus
  owner: string
  reviewerNotes: string[]
  evidenceIds: string[]
}

type TriageBundle = {
  schemaVersion: 1
  generatedAt: string
  runDir: string
  review: {
    status: DeliveryStatus
    reviewer: string
    note: string
    reviewedAt?: string
  }
  summary: {
    total: number
    needsReview: number
    informational: number
    highestSeverity: Severity | 'none'
  }
  findings: TriageFinding[]
  safety: {
    manualReviewRequired: boolean
    localOnly: true
    rawSecretsCopied: false
    rawPayloadsCopied: false
    notes: string[]
  }
}

type ManualTriageFinding = {
  id?: string
  triageStatus?: TriageStatus
  owner?: string
  reviewerNotes?: string[]
  note?: string
}

type ManualTriageInput = {
  findings?:
    | ManualTriageFinding[]
    | Record<string, Omit<ManualTriageFinding, 'id'>>
}

type SignedFile = {
  path: string
  role: string
  sha256: string
  bytes: number
}

type ReportSignature = {
  schemaVersion: 1
  generatedAt: string
  runDir: string
  algorithm: 'sha256'
  signatureKind: 'local-integrity-manifest'
  reviewer: string
  deliveryStatus: DeliveryStatus
  bundleDigest: string
  signedFiles: SignedFile[]
  notes: string[]
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
  bun run scripts/redscope-delivery.ts --run <tools/outputs/profile/run-id> [options]
  bun run scripts/redscope-delivery.ts --latest --profile <id> [options]

Options:
  --output-root <path>       Output root to search for --latest (default: ${defaultOutputRoot})
  --status <status>          draft | ready-for-review | approved | needs-changes
  --reviewer <name>          Reviewer name recorded in triage and signature
  --note <text>              Reviewer note or delivery note
  --triage-file <path>       JSON finding triage overrides
  --pdf                      Generate delivery/report.pdf
  --trace <path>             Append a local JSONL delivery trace event
  --skip-html                Do not generate report.html
  --force                    Overwrite an existing delivery directory
  --dry-run                  Build delivery metadata without writing files
  --json                     Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseDeliveryStatus(value: string): DeliveryStatus {
  if (
    value === 'draft' ||
    value === 'ready-for-review' ||
    value === 'approved' ||
    value === 'needs-changes'
  ) {
    return value
  }
  throw new Error(
    '--status must be draft, ready-for-review, approved, or needs-changes',
  )
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    latest: false,
    outputRoot: defaultOutputRoot,
    status: 'draft',
    dryRun: false,
    json: false,
    force: false,
    skipHtml: false,
    pdf: false,
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
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--skip-html') {
      options.skipHtml = true
      continue
    }
    if (arg === '--pdf') {
      options.pdf = true
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
      case '--status':
        options.status = parseDeliveryStatus(next)
        break
      case '--reviewer':
        options.reviewer = next
        break
      case '--note':
        options.note = next
        break
      case '--triage-file':
        options.triageFile = next
        break
      case '--trace':
        options.tracePath = next
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

async function signedFile(
  path: string,
  role: string,
): Promise<SignedFile | undefined> {
  if (!(await pathExists(path))) return undefined
  const info = await stat(path)
  if (!info.isFile()) return undefined
  return {
    path: projectPath(path),
    role,
    sha256: await sha256File(path),
    bytes: info.size,
  }
}

function bundleDigest(files: SignedFile[]): string {
  const hash = createHash('sha256')
  const canonical = files
    .map(file => ({
      path: file.path,
      role: file.role,
      sha256: file.sha256,
      bytes: file.bytes,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  hash.update(JSON.stringify(canonical))
  return hash.digest('hex')
}

async function findLatestRun(
  outputRoot: string,
  profileId: string,
): Promise<string> {
  const profileRoot = resolve(outputRoot, profileId)
  assertInside(profileRoot, outputRoot, 'profile output root')
  if (!(await pathExists(profileRoot))) {
    throw new Error(`${projectPath(profileRoot)} does not exist`)
  }

  const entries = await readdir(profileRoot, { withFileTypes: true })
  const candidates: Array<{ path: string; generatedAt: number; mtime: number }> =
    []
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

  const selected = [options.runPath ? 1 : 0, options.latest ? 1 : 0].reduce(
    (total, item) => total + item,
    0,
  )
  if (selected !== 1) usage()

  if (options.runPath) {
    const runDir = resolveProjectPath(options.runPath)
    assertInside(runDir, outputRoot, 'run directory')
    return runDir
  }

  if (!options.profileId) usage()
  return findLatestRun(outputRoot, options.profileId)
}

function reviewerName(options: Options): string {
  return options.reviewer?.trim() || 'unassigned'
}

function validateOptions(options: Options) {
  if (options.status === 'approved' && reviewerName(options) === 'unassigned') {
    throw new Error('--reviewer is required when --status approved')
  }
}

function normalizeManualTriage(
  input: ManualTriageInput | undefined,
): Map<string, ManualTriageFinding> {
  const overrides = new Map<string, ManualTriageFinding>()
  const findings = input?.findings
  if (!findings) return overrides

  if (Array.isArray(findings)) {
    for (const finding of findings) {
      if (finding.id) overrides.set(finding.id, finding)
    }
    return overrides
  }

  for (const [id, finding] of Object.entries(findings)) {
    overrides.set(id, { id, ...finding })
  }
  return overrides
}

async function readManualTriageFile(
  path: string | undefined,
): Promise<Map<string, ManualTriageFinding>> {
  if (!path) return new Map()
  const triagePath = resolveProjectPath(path)
  assertInside(triagePath, repoRoot, 'triage file')
  const input = await readJsonFile<ManualTriageInput>(triagePath)
  return normalizeManualTriage(input)
}

function applyManualTriage(
  finding: TriageFinding,
  override: ManualTriageFinding | undefined,
): TriageFinding {
  if (!override) return finding
  return {
    ...finding,
    triageStatus: override.triageStatus ?? finding.triageStatus,
    owner: override.owner?.trim() || finding.owner,
    reviewerNotes: [
      ...finding.reviewerNotes,
      ...(override.reviewerNotes ?? []),
      ...(override.note ? [override.note] : []),
    ].filter(note => note.trim().length > 0),
  }
}

function triageStatus(finding: Finding): TriageStatus {
  if (finding.status === 'informational') return 'informational'
  return 'needs-review'
}

function buildTriage(
  runDir: string,
  bundle: FindingBundle,
  options: Options,
  generatedAt: string,
  manualTriage: Map<string, ManualTriageFinding>,
): TriageBundle {
  const findings = (bundle.findings ?? []).map((finding): TriageFinding => {
    const status = triageStatus(finding)
    const triageFinding = {
      id: finding.id ?? 'unknown',
      title: finding.title ?? 'Untitled finding',
      severity: finding.severity ?? 'unknown',
      reportStatus: finding.status ?? 'unknown',
      confidence: finding.confidence ?? 'unknown',
      category: finding.category ?? 'unknown',
      target: finding.target ?? 'unknown',
      triageStatus: status,
      owner: 'unassigned',
      reviewerNotes: [],
      evidenceIds: (finding.evidence ?? [])
        .map(item => item.id)
        .filter((id): id is string => Boolean(id)),
    }
    return applyManualTriage(
      triageFinding,
      manualTriage.get(triageFinding.id),
    )
  })
  const needsReview = findings.filter(
    finding => finding.triageStatus === 'needs-review',
  ).length
  const informational = findings.filter(
    finding => finding.triageStatus === 'informational',
  ).length

  return {
    schemaVersion: 1,
    generatedAt,
    runDir: projectPath(runDir),
    review: {
      status: options.status,
      reviewer: reviewerName(options),
      note: options.note ?? '',
      reviewedAt: options.status === 'approved' ? generatedAt : undefined,
    },
    summary: {
      total: findings.length,
      needsReview,
      informational,
      highestSeverity: bundle.summary?.highestSeverity ?? 'none',
    },
    findings,
    safety: {
      manualReviewRequired: needsReview > 0,
      localOnly: true,
      rawSecretsCopied: false,
      rawPayloadsCopied: false,
      notes: [
        'Triage status starts from normalized findings and must be reviewed by a human before delivery.',
        'Reviewer notes are local delivery metadata and do not copy raw secrets, payloads, or response bodies.',
      ],
    },
  }
}

function renderReviewerNotes(
  run: RunManifest,
  bundle: FindingBundle,
  triage: TriageBundle,
): string {
  const profile = run.profile?.id ?? bundle.source?.profile?.id ?? 'unknown'
  const owner = run.authorization?.owner ?? bundle.source?.authorization?.owner
  const rows = triage.findings.map(
    finding => {
      const notes = finding.reviewerNotes.join('; ').replace(/\|/g, '\\|')
      return `| ${finding.id} | ${finding.severity} | ${finding.reportStatus} | ${finding.triageStatus} | ${finding.owner} | ${notes || '-'} | ${finding.title.replace(/\|/g, '\\|')} |`
    },
  )
  return `${[
    '# RedScope Reviewer Notes',
    '',
    `Run: \`${triage.runDir}\``,
    `Profile: \`${profile}\``,
    `Owner: \`${owner ?? 'unknown'}\``,
    `Delivery status: \`${triage.review.status}\``,
    `Reviewer: \`${triage.review.reviewer}\``,
    `Generated: \`${triage.generatedAt}\``,
    '',
    '## Delivery Checklist',
    '',
    '- [ ] Scope and authorization window were reviewed.',
    '- [ ] Findings were triaged by severity and confidence.',
    '- [ ] Evidence references resolve to local files.',
    '- [ ] Limitations were accepted by the reviewer.',
    '- [ ] No raw secrets, payloads, response bodies, or full incident contents were copied into deliverables.',
    '',
    '## Reviewer Note',
    '',
    triage.review.note || 'No reviewer note recorded.',
    '',
    '## Triage Table',
    '',
    '| ID | Severity | Report status | Triage status | Owner | Notes | Title |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| - | - | - | - | - | - | No findings |']),
    '',
    '## Safety Notes',
    '',
    ...triage.safety.notes.map(note => `- ${note}`),
  ].join('\n')}\n`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function tableToHtml(rows: string[]): string {
  const body = rows
    .filter(row => !/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row))
    .map((row, index) => {
      const cells = row
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => inlineMarkdown(cell.trim()))
      const tag = index === 0 ? 'th' : 'td'
      return `<tr>${cells.map(cell => `<${tag}>${cell}</${tag}>`).join('')}</tr>`
    })
    .join('\n')
  return `<table>\n${body}\n</table>`
}

function flushList(lines: string[], output: string[]) {
  if (lines.length === 0) return
  output.push(`<ul>${lines.map(line => `<li>${line}</li>`).join('')}</ul>`)
  lines.length = 0
}

function flushTable(lines: string[], output: string[]) {
  if (lines.length === 0) return
  output.push(tableToHtml(lines))
  lines.length = 0
}

function markdownToHtml(markdown: string): string {
  const output: string[] = []
  const listLines: string[] = []
  const tableLines: string[] = []
  let inCode = false
  let codeLines: string[] = []

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      flushList(listLines, output)
      flushTable(tableLines, output)
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
        inCode = false
      } else {
        inCode = true
      }
      continue
    }

    if (inCode) {
      codeLines.push(line)
      continue
    }

    if (line.trim() === '') {
      flushList(listLines, output)
      flushTable(tableLines, output)
      continue
    }

    if (line.startsWith('|')) {
      flushList(listLines, output)
      tableLines.push(line)
      continue
    }

    flushTable(tableLines, output)

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushList(listLines, output)
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    if (line.startsWith('- ')) {
      listLines.push(inlineMarkdown(line.slice(2)))
      continue
    }

    flushList(listLines, output)
    output.push(`<p>${inlineMarkdown(line)}</p>`)
  }

  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  flushList(listLines, output)
  flushTable(tableLines, output)
  return output.join('\n')
}

function renderHtmlDocument(
  reportMarkdown: string,
  triage: TriageBundle,
): string {
  const status = escapeHtml(triage.review.status)
  const reviewer = escapeHtml(triage.review.reviewer)
  const body = markdownToHtml(reportMarkdown)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RedScope Delivery Report</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2328;
      --muted: #5f6368;
      --line: #ded8d2;
      --surface: #fffaf6;
      --accent: #d77757;
      --blue: #5769f7;
    }
    body {
      margin: 0;
      background: #f7f3ef;
      color: var(--ink);
      font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 1040px;
      margin: 0 auto;
      padding: 40px 28px 56px;
      background: var(--surface);
      min-height: 100vh;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    h1, h2, h3 {
      line-height: 1.2;
      margin: 1.6em 0 0.6em;
    }
    header h1 {
      margin: 0 0 12px;
      font-size: 30px;
      letter-spacing: 0;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      color: var(--muted);
    }
    .meta strong {
      display: block;
      color: var(--ink);
    }
    code {
      background: #f0e7df;
      border-radius: 4px;
      padding: 1px 4px;
    }
    pre {
      background: #231f1c;
      color: #f8f4f0;
      padding: 14px;
      overflow-x: auto;
      border-radius: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      background: #fff;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #efe8e1;
    }
    .status {
      color: var(--accent);
      font-weight: 700;
    }
    .digest {
      color: var(--blue);
      word-break: break-all;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>RedScope Delivery Report</h1>
      <div class="meta">
        <div><strong>Status</strong><span class="status">${status}</span></div>
        <div><strong>Reviewer</strong>${reviewer}</div>
        <div><strong>Findings</strong>${triage.summary.total}</div>
        <div><strong>Integrity manifest</strong><span class="digest">delivery/report-signature.json</span></div>
      </div>
    </header>
    ${body}
  </main>
</body>
</html>
`
}

function pdfEscape(value: string): string {
  return value
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function wrapPdfLine(line: string, width: number): string[] {
  const clean = line.replace(/\s+/g, ' ').trim()
  if (!clean) return ['']
  const wrapped: string[] = []
  let remaining = clean
  while (remaining.length > width) {
    const cut = remaining.lastIndexOf(' ', width)
    const index = cut > 20 ? cut : width
    wrapped.push(remaining.slice(0, index))
    remaining = remaining.slice(index).trim()
  }
  wrapped.push(remaining)
  return wrapped
}

function markdownToPdfLines(markdown: string, triage: TriageBundle): string[] {
  const lines = [
    'RedScope Delivery Report',
    `Status: ${triage.review.status}`,
    `Reviewer: ${triage.review.reviewer}`,
    `Findings: ${triage.summary.total}`,
    '',
  ]

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^#{1,6}\s+/, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^\|\s*/, '')
      .replace(/\s*\|/g, ' | ')
    lines.push(...wrapPdfLine(line, 92))
  }
  return lines
}

function renderPdfDocument(markdown: string, triage: TriageBundle): Buffer {
  const pageLines = 48
  const lines = markdownToPdfLines(markdown, triage)
  const pages: string[][] = []
  for (let index = 0; index < lines.length; index += pageLines) {
    pages.push(lines.slice(index, index + pageLines))
  }
  if (pages.length === 0) pages.push(['RedScope Delivery Report'])

  const objects: string[] = []
  const addObject = (content: string): number => {
    objects.push(content)
    return objects.length
  }

  const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>')
  const pagesId = addObject('')
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []

  for (const page of pages) {
    const commands = [
      'BT',
      '/F1 10 Tf',
      '50 780 Td',
      '14 TL',
      ...page.map(line => `(${pdfEscape(line)}) Tj T*`),
      'ET',
    ].join('\n')
    const streamId = addObject(
      `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    )
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`,
    )
    pageIds.push(pageId)
  }

  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  objects[catalogId - 1] = '<< /Type /Catalog /Pages 2 0 R >>'

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function ensureDeliveryDir(deliveryDir: string, force: boolean) {
  if (await pathExists(deliveryDir)) {
    const entries = await readdir(deliveryDir)
    if (entries.length > 0 && !force) {
      throw new Error(
        `${projectPath(deliveryDir)} already exists. Pass --force to overwrite delivery artifacts.`,
      )
    }
  }
  await mkdir(deliveryDir, { recursive: true })
}

async function signedFilesForRun(
  runDir: string,
  includeHtml: boolean,
  includePdf: boolean,
  includeTrace: boolean,
): Promise<SignedFile[]> {
  const candidates: Array<[string, string]> = [
    ['run.json', 'run-manifest'],
    ['scope.snapshot.json', 'scope-snapshot'],
    ['targets.txt', 'target-list'],
    ['command-manifest.json', 'command-manifest'],
    ['findings.json', 'findings'],
    ['evidence-index.json', 'evidence-index'],
    ['report.md', 'markdown-report'],
    ['workflow-manifest.json', 'workflow-manifest'],
    ['delivery/triage.json', 'triage'],
    ['delivery/reviewer-notes.md', 'reviewer-notes'],
  ]
  if (includeHtml) candidates.push(['delivery/report.html', 'html-report'])
  if (includePdf) candidates.push(['delivery/report.pdf', 'pdf-report'])
  if (includeTrace) candidates.push(['delivery/trace-event.json', 'trace-event'])
  const files: SignedFile[] = []
  for (const [relativePath, role] of candidates) {
    const item = await signedFile(join(runDir, relativePath), role)
    if (item) files.push(item)
  }
  return files
}

async function runDelivery(options: Options) {
  validateOptions(options)
  const runDir = await resolveRunDir(options)
  if (!(await pathExists(join(runDir, 'run.json')))) {
    throw new Error(`${projectPath(runDir)} is missing run.json`)
  }
  if (!(await pathExists(join(runDir, 'findings.json')))) {
    throw new Error(`${projectPath(runDir)} is missing findings.json; run redscope:report first`)
  }
  if (!(await pathExists(join(runDir, 'report.md')))) {
    throw new Error(`${projectPath(runDir)} is missing report.md; run redscope:report first`)
  }

  const generatedAt = new Date().toISOString()
  const run = await readJsonFile<RunManifest>(join(runDir, 'run.json'))
  const findings = await readJsonFile<FindingBundle>(join(runDir, 'findings.json'))
  const evidenceIndex = await readJsonFile<EvidenceIndex>(
    join(runDir, 'evidence-index.json'),
  )
  const reportMarkdown = await readFile(join(runDir, 'report.md'), 'utf8')
  const manualTriage = await readManualTriageFile(options.triageFile)
  const deliveryDir = join(runDir, 'delivery')
  const triage = buildTriage(
    runDir,
    findings,
    options,
    generatedAt,
    manualTriage,
  )
  const reviewerNotes = renderReviewerNotes(run, findings, triage)
  const evidenceCount = evidenceIndex.evidence?.length ?? 0
  const traceEvent = options.tracePath
    ? {
        schemaVersion: 1,
        event: 'redscope.delivery.generated',
        generatedAt,
        runDir: projectPath(runDir),
        deliveryStatus: triage.review.status,
        reviewer: triage.review.reviewer,
        summary: triage.summary,
        localOnly: true,
      }
    : undefined

  if (!options.dryRun) {
    await ensureDeliveryDir(deliveryDir, options.force)
    await writeJson(join(deliveryDir, 'triage.json'), triage)
    await writeText(join(deliveryDir, 'reviewer-notes.md'), reviewerNotes)
    if (traceEvent) {
      await writeJson(join(deliveryDir, 'trace-event.json'), traceEvent)
    }
  }

  if (!options.skipHtml) {
    const html = renderHtmlDocument(reportMarkdown, triage)
    if (!options.dryRun) {
      await writeText(join(deliveryDir, 'report.html'), html)
    }
  }

  if (options.pdf && !options.dryRun) {
    await writeFile(
      join(deliveryDir, 'report.pdf'),
      renderPdfDocument(reportMarkdown, triage),
    )
  }

  const signedFiles = await signedFilesForRun(
    runDir,
    !options.skipHtml,
    options.pdf,
    Boolean(traceEvent),
  )
  const digest = bundleDigest(signedFiles)

  const signature: ReportSignature = {
    schemaVersion: 1,
    generatedAt,
    runDir: projectPath(runDir),
    algorithm: 'sha256',
    signatureKind: 'local-integrity-manifest',
    reviewer: triage.review.reviewer,
    deliveryStatus: triage.review.status,
    bundleDigest: digest,
    signedFiles,
    notes: [
      'This is a local integrity manifest, not a PKI signature or legal attestation.',
      'Verify signed file hashes before sharing or archiving deliverables.',
      'Delivery artifacts avoid copying raw secrets, payloads, response bodies, or full incident contents.',
    ],
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    runDir: projectPath(runDir),
    deliveryDir: projectPath(deliveryDir),
    status: triage.review.status,
    reviewer: triage.review.reviewer,
    generatedFiles: {
      triage: projectPath(join(deliveryDir, 'triage.json')),
      reviewerNotes: projectPath(join(deliveryDir, 'reviewer-notes.md')),
      reportHtml: options.skipHtml
        ? null
        : projectPath(join(deliveryDir, 'report.html')),
      reportPdf: options.pdf
        ? projectPath(join(deliveryDir, 'report.pdf'))
        : null,
      traceEvent: traceEvent
        ? projectPath(join(deliveryDir, 'trace-event.json'))
        : null,
      reportSignature: projectPath(join(deliveryDir, 'report-signature.json')),
      deliveryManifest: projectPath(join(deliveryDir, 'delivery-manifest.json')),
    },
    summary: {
      findings: triage.summary.total,
      needsReview: triage.summary.needsReview,
      informational: triage.summary.informational,
      highestSeverity: triage.summary.highestSeverity,
      evidenceCount,
      signedFiles: signature.signedFiles.length,
      bundleDigest: signature.bundleDigest,
    },
    safety: triage.safety,
  }

  if (!options.dryRun) {
    await writeJson(join(deliveryDir, 'report-signature.json'), signature)
    await writeJson(join(deliveryDir, 'delivery-manifest.json'), manifest)
    if (options.tracePath) {
      const tracePath = resolveProjectPath(options.tracePath)
      assertInside(tracePath, repoRoot, 'trace path')
      await mkdir(dirname(tracePath), { recursive: true })
      await appendFile(
        tracePath,
        `${JSON.stringify({
          ...traceEvent,
          deliveryDir: projectPath(deliveryDir),
          bundleDigest: signature.bundleDigest,
          signedFiles: signature.signedFiles.length,
        })}\n`,
      )
    }
  }

  const result = {
    dryRun: options.dryRun,
    ...manifest,
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`${options.dryRun ? 'Prepared' : 'Wrote'} RedScope delivery`)
  console.log(`  run: ${projectPath(runDir)}`)
  console.log(`  delivery: ${projectPath(deliveryDir)}`)
  console.log(`  status: ${triage.review.status}`)
  console.log(`  findings needing review: ${triage.summary.needsReview}`)
  console.log(`  signature: ${signature.bundleDigest}`)
}

runDelivery(parseArgs(process.argv.slice(2))).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`redscope-delivery: ${message}`)
  process.exit(1)
})
