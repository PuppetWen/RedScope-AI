#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, open, stat, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { envPathFrom } from './redscope-env-config.ts'

type Options = {
  artifactPath?: string
  outputPath?: string
  outputRoot: string
  maxChunks: number
  maxEvents: number
  dryRun: boolean
  json: boolean
}

type EvtxDeepSummary = {
  schemaVersion: 1
  generatedAt: string
  artifact: {
    path: string
    bytes: number
    sha256: string
  }
  policy: {
    explicitOnly: true
    defaultProfileIntegration: false
    localOnly: true
    storesRawEventBodies: false
    storesRenderedEventData: false
    notes: string[]
  }
  limits: {
    maxChunks: number
    maxEvents: number
  }
  header: {
    formatDetected: boolean
    majorVersion?: number
    minorVersion?: number
    firstChunkNumber?: string
    lastChunkNumber?: string
    nextRecordIdentifier?: string
    declaredChunkCount?: number
  }
  chunks: {
    scanned: number
    detected: number
    malformed: number
    truncatedByLimit: boolean
    firstRecordNumber?: string
    lastRecordNumber?: string
    firstRecordIdentifier?: string
    lastRecordIdentifier?: string
  }
  events: {
    scanned: number
    truncatedByLimit: boolean
    timestampCount: number
    firstTimestamp?: string
    lastTimestamp?: string
    firstRecordIdentifier?: string
    lastRecordIdentifier?: string
    recordIdentifierGapCount: number
    previousRecordIdentifier?: bigint
    sizeMin?: number
    sizeMax?: number
    sizeBuckets: Record<string, number>
    perHourCounts: Record<string, number>
    sizeMismatchCount: number
    truncatedRecordCount: number
  }
  binXml: {
    scannedBytes: number
    tokenCounts: Record<string, number>
    templateInstanceCount: number
    normalSubstitutionCount: number
    optionalSubstitutionCount: number
    fragmentHeaderCount: number
    templateIdentifierDigests: string[]
  }
  warnings: string[]
}

type EventScan = EvtxDeepSummary['events'] & {
  previousRecordIdentifier?: bigint
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_OUTPUT_ROOT', 'REDSCOPE_OUTPUT_ROOT'],
  'tools/outputs',
)

const evtxChunkSize = 64 * 1024
const evtxFileHeaderSize = 4096
const evtxChunkHeaderSize = 512
const evtxEventRecordMagic = Buffer.from([0x2a, 0x2a, 0x00, 0x00])
const evtxEventRecordHeaderSize = 24
const evtxEventRecordMinimumSize = 28
const windowsFileTimeUnixEpochOffset = 116444736000000000n

const evtxBinXmlTokenNames: Record<number, string> = {
  0x01: 'open-start-element',
  0x02: 'close-start-element',
  0x03: 'close-empty-element',
  0x04: 'end-element',
  0x05: 'value',
  0x06: 'attribute',
  0x07: 'cdata-section',
  0x08: 'char-ref',
  0x09: 'entity-ref',
  0x0a: 'pi-target',
  0x0b: 'pi-data',
  0x0c: 'template-instance',
  0x0d: 'normal-substitution',
  0x0e: 'optional-substitution',
  0x0f: 'fragment-header',
}

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-evtx-deep-parser.ts --artifact <path> [options]

Options:
  --artifact <path>    EVTX file under the project workspace
  --output <path>      Summary output path
  --output-root <path> Output root (default: ${defaultOutputRoot})
  --max-chunks <n>     Maximum chunks to scan (default: 256)
  --max-events <n>     Maximum event records to scan (default: 5000)
  --dry-run            Print summary without writing files
  --json               Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outputRoot: defaultOutputRoot,
    maxChunks: 256,
    maxEvents: 5000,
    dryRun: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
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
      case '--artifact':
        options.artifactPath = next
        break
      case '--output':
        options.outputPath = next
        break
      case '--output-root':
        options.outputRoot = next
        break
      case '--max-chunks':
        options.maxChunks = parsePositiveInteger(next, '--max-chunks')
        break
      case '--max-events':
        options.maxEvents = parsePositiveInteger(next, '--max-events')
        break
      default:
        usage()
    }
    index++
  }

  if (!options.artifactPath) usage()
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

function addCount(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1
}

function minDecimalString(current: string | undefined, next: string): string {
  if (current == null) return next
  return BigInt(next) < BigInt(current) ? next : current
}

function maxDecimalString(current: string | undefined, next: string): string {
  if (current == null) return next
  return BigInt(next) > BigInt(current) ? next : current
}

function windowsFileTimeToIso(fileTime: bigint): string | undefined {
  if (fileTime <= windowsFileTimeUnixEpochOffset) return undefined
  const millis = Number((fileTime - windowsFileTimeUnixEpochOffset) / 10000n)
  if (!Number.isFinite(millis)) return undefined
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function recordTimestamp(events: EventScan, timestamp: string | undefined) {
  if (!timestamp) return
  events.timestampCount++
  events.firstTimestamp =
    events.firstTimestamp == null || timestamp < events.firstTimestamp
      ? timestamp
      : events.firstTimestamp
  events.lastTimestamp =
    events.lastTimestamp == null || timestamp > events.lastTimestamp
      ? timestamp
      : events.lastTimestamp
  addCount(events.perHourCounts, timestamp.slice(0, 13))
}

function recordTemplateDigest(summary: EvtxDeepSummary, bytes: Buffer) {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (
    !summary.binXml.templateIdentifierDigests.includes(digest) &&
    summary.binXml.templateIdentifierDigests.length < 50
  ) {
    summary.binXml.templateIdentifierDigests.push(digest)
  }
}

function scanBinXml(body: Buffer, summary: EvtxDeepSummary) {
  summary.binXml.scannedBytes += body.length
  for (let index = 0; index < body.length; index++) {
    const token = body[index]
    const name = evtxBinXmlTokenNames[token]
    if (!name) continue
    addCount(summary.binXml.tokenCounts, name)
    if (token === 0x0c) {
      summary.binXml.templateInstanceCount++
      if (index + 17 <= body.length) {
        recordTemplateDigest(summary, body.subarray(index + 1, index + 17))
        index += 16
      }
    } else if (token === 0x0d) {
      summary.binXml.normalSubstitutionCount++
    } else if (token === 0x0e) {
      summary.binXml.optionalSubstitutionCount++
    } else if (token === 0x0f) {
      summary.binXml.fragmentHeaderCount++
    }
  }
}

function sizeBucket(recordSize: number): string {
  if (recordSize < 256) return '<256'
  if (recordSize < 1024) return '256-1023'
  if (recordSize < 4096) return '1024-4095'
  if (recordSize < 16384) return '4096-16383'
  return '>=16384'
}

function scanChunk(chunk: Buffer, summary: EvtxDeepSummary) {
  if (!chunk.toString('ascii', 0, 8).startsWith('ElfChnk')) {
    summary.chunks.malformed++
    summary.warnings.push('EVTX chunk header did not contain expected chunk magic')
    return
  }

  summary.chunks.detected++
  if (chunk.length >= 40) {
    const firstRecordNumber = chunk.readBigUInt64LE(8).toString()
    const lastRecordNumber = chunk.readBigUInt64LE(16).toString()
    const firstRecordIdentifier = chunk.readBigUInt64LE(24).toString()
    const lastRecordIdentifier = chunk.readBigUInt64LE(32).toString()
    summary.chunks.firstRecordNumber = minDecimalString(
      summary.chunks.firstRecordNumber,
      firstRecordNumber,
    )
    summary.chunks.lastRecordNumber = maxDecimalString(
      summary.chunks.lastRecordNumber,
      lastRecordNumber,
    )
    summary.chunks.firstRecordIdentifier = minDecimalString(
      summary.chunks.firstRecordIdentifier,
      firstRecordIdentifier,
    )
    summary.chunks.lastRecordIdentifier = maxDecimalString(
      summary.chunks.lastRecordIdentifier,
      lastRecordIdentifier,
    )
  }

  let offset = evtxChunkHeaderSize
  while (
    offset + evtxEventRecordMinimumSize <= chunk.length &&
    summary.events.scanned < summary.limits.maxEvents
  ) {
    const recordOffset = chunk.indexOf(evtxEventRecordMagic, offset)
    if (
      recordOffset < 0 ||
      recordOffset + evtxEventRecordMinimumSize > chunk.length
    ) {
      break
    }

    const recordSize = chunk.readUInt32LE(recordOffset + 4)
    if (recordSize < evtxEventRecordMinimumSize) {
      summary.events.sizeMismatchCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }
    if (recordOffset + recordSize > chunk.length) {
      summary.events.truncatedRecordCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }

    const trailingSize = chunk.readUInt32LE(recordOffset + recordSize - 4)
    if (trailingSize !== recordSize) {
      summary.events.sizeMismatchCount++
      offset = recordOffset + evtxEventRecordMagic.length
      continue
    }

    const recordIdentifierValue = chunk.readBigUInt64LE(recordOffset + 8)
    const recordIdentifier = recordIdentifierValue.toString()
    const timestamp = windowsFileTimeToIso(
      chunk.readBigUInt64LE(recordOffset + 16),
    )

    summary.events.scanned++
    summary.events.firstRecordIdentifier = minDecimalString(
      summary.events.firstRecordIdentifier,
      recordIdentifier,
    )
    summary.events.lastRecordIdentifier = maxDecimalString(
      summary.events.lastRecordIdentifier,
      recordIdentifier,
    )
    if (
      summary.events.previousRecordIdentifier != null &&
      recordIdentifierValue > summary.events.previousRecordIdentifier + 1n
    ) {
      summary.events.recordIdentifierGapCount++
    }
    summary.events.previousRecordIdentifier = recordIdentifierValue
    summary.events.sizeMin =
      summary.events.sizeMin == null
        ? recordSize
        : Math.min(summary.events.sizeMin, recordSize)
    summary.events.sizeMax =
      summary.events.sizeMax == null
        ? recordSize
        : Math.max(summary.events.sizeMax, recordSize)
    addCount(summary.events.sizeBuckets, sizeBucket(recordSize))
    recordTimestamp(summary.events, timestamp)
    scanBinXml(
      chunk.subarray(
        recordOffset + evtxEventRecordHeaderSize,
        recordOffset + recordSize - 4,
      ),
      summary,
    )
    offset = recordOffset + recordSize
  }

  if (
    summary.events.scanned >= summary.limits.maxEvents &&
    offset + evtxEventRecordMinimumSize <= chunk.length &&
    chunk.indexOf(evtxEventRecordMagic, offset) >= 0
  ) {
    summary.events.truncatedByLimit = true
  }
}

function emptySummary(
  artifactPath: string,
  bytes: number,
  sha256: string,
  options: Options,
): EvtxDeepSummary {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifact: {
      path: projectPath(artifactPath),
      bytes,
      sha256,
    },
    policy: {
      explicitOnly: true,
      defaultProfileIntegration: false,
      localOnly: true,
      storesRawEventBodies: false,
      storesRenderedEventData: false,
      notes: [
        'This parser is an explicit forensic helper, not part of default RedScope reports.',
        'It scans EVTX structure, chunk headers, event record headers, timestamps, sizes, and bounded BinXML token metadata only.',
        'It does not render Windows Event XML and does not copy raw event bodies, payloads, secrets, or message text.',
      ],
    },
    limits: {
      maxChunks: options.maxChunks,
      maxEvents: options.maxEvents,
    },
    header: {
      formatDetected: false,
    },
    chunks: {
      scanned: 0,
      detected: 0,
      malformed: 0,
      truncatedByLimit: false,
    },
    events: {
      scanned: 0,
      truncatedByLimit: false,
      timestampCount: 0,
      recordIdentifierGapCount: 0,
      sizeBuckets: {},
      perHourCounts: {},
      sizeMismatchCount: 0,
      truncatedRecordCount: 0,
    },
    binXml: {
      scannedBytes: 0,
      tokenCounts: {},
      templateInstanceCount: 0,
      normalSubstitutionCount: 0,
      optionalSubstitutionCount: 0,
      fragmentHeaderCount: 0,
      templateIdentifierDigests: [],
    },
    warnings: [],
  }
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  let position = 0
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return `sha256:${hash.digest('hex')}`
}

async function parseEvtx(path: string, options: Options): Promise<EvtxDeepSummary> {
  const info = await stat(path)
  const sha256 = await hashFile(path)
  const summary = emptySummary(path, info.size, sha256, options)
  const handle = await open(path, 'r')

  try {
    const header = await readAt(
      handle,
      0,
      Math.min(evtxFileHeaderSize, info.size),
    )
    const formatDetected = header.toString('ascii', 0, 8).startsWith('ElfFile')
    summary.header.formatDetected = formatDetected
    if (!formatDetected) {
      summary.warnings.push('EVTX file header magic was not detected')
      return summary
    }
    if (header.length < 48) {
      summary.warnings.push('EVTX file header is truncated')
      return summary
    }

    summary.header.firstChunkNumber = header.readBigUInt64LE(8).toString()
    summary.header.lastChunkNumber = header.readBigUInt64LE(16).toString()
    summary.header.nextRecordIdentifier = header.readBigUInt64LE(24).toString()
    summary.header.minorVersion = header.readUInt16LE(36)
    summary.header.majorVersion = header.readUInt16LE(38)
    const firstChunk = Number(header.readBigUInt64LE(8))
    const lastChunk = Number(header.readBigUInt64LE(16))
    if (
      Number.isSafeInteger(firstChunk) &&
      Number.isSafeInteger(lastChunk) &&
      lastChunk >= firstChunk
    ) {
      summary.header.declaredChunkCount = lastChunk - firstChunk + 1
    }

    let position = evtxFileHeaderSize
    while (
      position + 8 <= info.size &&
      summary.chunks.scanned < options.maxChunks &&
      summary.events.scanned < options.maxEvents
    ) {
      const chunk = await readAt(
        handle,
        position,
        Math.min(evtxChunkSize, info.size - position),
      )
      if (chunk.length === 0) break
      summary.chunks.scanned++
      scanChunk(chunk, summary)
      position += evtxChunkSize
    }

    if (position + 8 <= info.size) {
      summary.chunks.truncatedByLimit = true
    }
  } finally {
    await handle.close()
  }

  delete summary.events.previousRecordIdentifier
  return summary
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function defaultOutputPath(artifactPath: string, outputRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = basename(artifactPath).replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(outputRoot, 'evtx-deep', `${stamp}-${base}`, 'evtx-deep-summary.json')
}

async function run(options: Options) {
  const artifactPath = resolveProjectPath(options.artifactPath ?? '')
  assertInside(artifactPath, repoRoot, 'artifact path')
  if (!(await pathExists(artifactPath))) {
    throw new Error(`${projectPath(artifactPath)} does not exist`)
  }
  if (extname(artifactPath).toLowerCase() !== '.evtx') {
    throw new Error('artifact must use the .evtx extension')
  }

  const outputRoot = resolveProjectPath(options.outputRoot)
  assertInside(outputRoot, repoRoot, 'output root')
  const outputPath = options.outputPath
    ? resolveProjectPath(options.outputPath)
    : defaultOutputPath(artifactPath, outputRoot)
  assertInside(outputPath, outputRoot, 'output path')

  const summary = await parseEvtx(artifactPath, options)
  const payload = `${JSON.stringify(summary, null, 2)}\n`

  if (!options.dryRun) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, payload)
  }

  const result = {
    status: 'completed',
    outputPath: options.dryRun ? undefined : projectPath(outputPath),
    summary,
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('EVTX deep parser completed')
  if (!options.dryRun) console.log(`  output: ${projectPath(outputPath)}`)
  console.log(`  chunks: ${summary.chunks.detected}/${summary.chunks.scanned}`)
  console.log(`  events: ${summary.events.scanned}`)
}

run(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-evtx-deep-parser: ${error.message}`)
  process.exit(1)
})
