import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwdState, setOriginalCwd } from '../../bootstrap/state.js'
import {
  beginHostTest,
  completeHostTest,
  reportHostFinding,
  reportHostProgress,
} from '../engagementProgress'
import { loadEngagementGraph } from '../engagementGraph'

let prevCwd: string
let dir: string

describe('engagementProgress auto-write', () => {
  beforeEach(() => {
    prevCwd = process.cwd()
    dir = mkdtempSync(join(tmpdir(), 'redscope-progress-'))
    setOriginalCwd(dir)
    setCwdState(dir)
  })

  afterEach(() => {
    setOriginalCwd(prevCwd)
    setCwdState(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  test('begin/report/complete persist progress into redscope-engagement.json', () => {
    beginHostTest({
      hostId: 'ext-web',
      label: 'edge-web',
      ip: '203.0.113.10',
      activity: 'http fingerprint',
    })
    reportHostProgress({
      hostId: 'ext-web',
      progress: 45,
      activity: 'running template checks',
      refreshMap: false,
    })
    reportHostFinding({
      hostId: 'ext-web',
      title: 'Path traversal',
      severity: 'high',
      status: 'confirmed',
      cve: 'CVE-2021-41773',
      evidence: 'file contents: root:x:0:0',
      progress: 80,
    })
    completeHostTest({
      hostId: 'ext-web',
      status: 'compromised',
      activity: 'foothold',
    })

    expect(existsSync(join(dir, 'redscope-engagement.json'))).toBe(true)
    const graph = loadEngagementGraph()
    expect(graph).not.toBeNull()
    const host = graph!.hosts.find(h => h.id === 'ext-web')!
    expect(host.progress).toBe(100)
    expect(host.status).toBe('compromised')
    expect(host.findings).toHaveLength(1)
    expect(host.findings[0]!.cve).toBe('CVE-2021-41773')

    const raw = JSON.parse(
      readFileSync(join(dir, 'redscope-engagement.json'), 'utf-8'),
    )
    expect(typeof raw.updatedAt).toBe('string')
  })

  test('reportHostProgress creates a missing host on the fly', () => {
    reportHostProgress({
      hostId: 'new-host',
      label: 'fresh',
      progress: 10,
      status: 'scanning',
      refreshMap: false,
    })
    const graph = loadEngagementGraph()
    expect(graph!.hosts).toHaveLength(1)
    expect(graph!.hosts[0]!.label).toBe('fresh')
    expect(graph!.hosts[0]!.progress).toBe(10)
  })
})
