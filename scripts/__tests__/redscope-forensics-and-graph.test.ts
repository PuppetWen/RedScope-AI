import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const windowsFileTimeUnixEpochOffset = 116444736000000000n
let testRoot = ''

function projectPath(path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function fileTimeFromIso(iso: string): bigint {
  return BigInt(new Date(iso).getTime()) * 10000n + windowsFileTimeUnixEpochOffset
}

function syntheticEvtx(): Buffer {
  const header = Buffer.alloc(4096)
  header.write('ElfFile\0', 0, 'ascii')
  header.writeBigUInt64LE(0n, 8)
  header.writeBigUInt64LE(0n, 16)
  header.writeBigUInt64LE(2n, 24)
  header.writeUInt32LE(4096, 32)
  header.writeUInt16LE(3, 36)
  header.writeUInt16LE(3, 38)
  header.writeUInt16LE(4096, 40)

  const chunk = Buffer.alloc(64 * 1024)
  chunk.write('ElfChnk\0', 0, 'ascii')
  chunk.writeBigUInt64LE(1n, 8)
  chunk.writeBigUInt64LE(1n, 16)
  chunk.writeBigUInt64LE(1n, 24)
  chunk.writeBigUInt64LE(1n, 32)

  const body = Buffer.concat([
    Buffer.from([0x0f, 0x0c]),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from([0x0d, 0x0e]),
  ])
  const recordOffset = 512
  const recordSize = 24 + body.length + 4
  chunk.writeUInt32LE(0x00002a2a, recordOffset)
  chunk.writeUInt32LE(recordSize, recordOffset + 4)
  chunk.writeBigUInt64LE(1n, recordOffset + 8)
  chunk.writeBigUInt64LE(fileTimeFromIso('2026-05-20T12:00:00.000Z'), recordOffset + 16)
  body.copy(chunk, recordOffset + 24)
  chunk.writeUInt32LE(recordSize, recordOffset + recordSize - 4)

  return Buffer.concat([header, chunk])
}

async function runJson(script: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr || stdout)
  }
  return JSON.parse(stdout) as Record<string, unknown>
}

beforeEach(async () => {
  testRoot = join(
    repoRoot,
    'tools',
    `tmp-forensics-graph-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true })
  }
})

describe('EVTX and graph import helpers', () => {
  test('EVTX deep parser writes bounded metadata without raw event bodies', async () => {
    const artifactPath = join(testRoot, 'security.evtx')
    const outputPath = join(testRoot, 'evtx-summary.json')
    await writeFile(artifactPath, syntheticEvtx())

    const result = await runJson('scripts/redscope-evtx-deep-parser.ts', [
      '--artifact',
      projectPath(artifactPath),
      '--output-root',
      projectPath(testRoot),
      '--output',
      projectPath(outputPath),
      '--json',
    ])

    expect(result.status).toBe('completed')
    const summary = result.summary as {
      policy: {
        storesRawEventBodies: boolean
        storesRenderedEventData: boolean
      }
      chunks: { detected: number }
      events: { scanned: number; firstTimestamp: string }
      binXml: { templateInstanceCount: number }
    }
    expect(summary.policy.storesRawEventBodies).toBe(false)
    expect(summary.policy.storesRenderedEventData).toBe(false)
    expect(summary.chunks.detected).toBe(1)
    expect(summary.events.scanned).toBe(1)
    expect(summary.events.firstTimestamp).toBe('2026-05-20T12:00:00.000Z')
    expect(summary.binXml.templateInstanceCount).toBe(1)

    const written = await readFile(outputPath, 'utf8')
    expect(written).not.toContain('00112233445566778899aabbccddeeff')
    expect(written).not.toContain('rawEvent')
  })

  test('graph import prepares a retention- and access-controlled import bundle', async () => {
    const graphPath = join(testRoot, 'graph.json')
    const outputDir = join(testRoot, 'graph-import')
    await writeJson(graphPath, {
      schemaVersion: 1,
      generatedAt: '2026-05-20T00:00:00.000Z',
      policy: {
        localOnly: true,
        storesRawSecrets: false,
        storesResponseBodies: false,
        graphStore: 'json',
      },
      nodes: [
        {
          id: 'run:test',
          kind: 'run',
          label: 'test run',
          properties: { profile: 'baseline-url-review' },
        },
      ],
      edges: [],
    })

    const manifest = await runJson('scripts/redscope-graph-import.ts', [
      '--graph',
      projectPath(graphPath),
      '--output-dir',
      projectPath(outputDir),
      '--retention-days',
      '30',
      '--access-label',
      'redscope_internal',
      '--owner',
      'Security Team',
      '--purpose',
      'unit test import',
      '--json',
    ])

    expect(manifest.status).toBe('prepared')
    expect((manifest.controls as { retentionDays: number }).retentionDays).toBe(30)
    expect((manifest.policy as { requiresAccessLabel: boolean }).requiresAccessLabel).toBe(true)

    const cypher = await readFile(join(outputDir, 'import.cypher'), 'utf8')
    expect(cypher).toContain('RedScopeImport')
    expect(cypher).toContain('redscope_internal')
  })
})
