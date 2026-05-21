import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendRemoteTriggerAuditRecord,
  formatRemoteTriggerAuditStatus,
  listRemoteTriggerAuditRecords,
  resolveRemoteTriggerAuditPath,
} from '../remoteTriggerAudit'

let tempDir = ''

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `remote-trigger-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('remote trigger audit', () => {
  test('records and formats local remote trigger audit events', async () => {
    await appendRemoteTriggerAuditRecord(
      { action: 'run', triggerId: 'abc', ok: true, status: 200, createdAt: 1 },
      tempDir,
    )
    await appendRemoteTriggerAuditRecord(
      { action: 'create', ok: false, error: 'bad request', createdAt: 2 },
      tempDir,
    )

    const records = await listRemoteTriggerAuditRecords(tempDir)
    expect(resolveRemoteTriggerAuditPath(tempDir)).toBe(
      join(tempDir, '.redscope', 'remote-trigger-audit.jsonl'),
    )
    expect(
      await readFile(resolveRemoteTriggerAuditPath(tempDir), 'utf-8'),
    ).toContain('"action":"run"')
    expect(records).toHaveLength(2)
    expect(records[0].action).toBe('create')
    expect(formatRemoteTriggerAuditStatus(records)).toContain(
      'RemoteTrigger audit records: 2',
    )
    expect(formatRemoteTriggerAuditStatus(records)).toContain('Failures: 1')
  })

  test('reads legacy .claude audit records', async () => {
    await mkdir(join(tempDir, '.claude'), { recursive: true })
    await writeFile(
      join(tempDir, '.claude', 'remote-trigger-audit.jsonl'),
      `${JSON.stringify({
        auditId: 'legacy-1',
        createdAt: 1,
        action: 'list',
        ok: true,
        status: 200,
      })}\n`,
      'utf-8',
    )

    const records = await listRemoteTriggerAuditRecords(tempDir)

    expect(records).toHaveLength(1)
    expect(records[0]?.auditId).toBe('legacy-1')
  })
})
