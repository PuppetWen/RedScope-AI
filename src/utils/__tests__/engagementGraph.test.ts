import { describe, expect, test } from 'bun:test'
import {
  addFinding,
  createEngagementGraph,
  formatEngagementStatus,
  normalizeEngagementGraph,
  setHostProgress,
  summarizeEngagement,
  upsertEdge,
  upsertHost,
} from '../engagementGraph'

describe('normalizeEngagementGraph', () => {
  test('drops hosts without ids and de-duplicates host ids', () => {
    const graph = normalizeEngagementGraph({
      hosts: [
        { id: 'a', label: 'A' },
        { label: 'no id' },
        { id: 'a', label: 'dup' },
      ],
    })
    expect(graph.hosts.map(h => h.id)).toEqual(['a'])
    expect(graph.hosts[0]!.label).toBe('A')
  })

  test('drops edges that reference unknown hosts', () => {
    const graph = normalizeEngagementGraph({
      hosts: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { from: 'a', to: 'b', kind: 'pivot' },
        { from: 'a', to: 'ghost', kind: 'route' },
      ],
    })
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ from: 'a', to: 'b', kind: 'pivot' })
  })

  test('coerces invalid zone/status/severity to safe defaults', () => {
    const graph = normalizeEngagementGraph({
      hosts: [
        {
          id: 'a',
          zone: 'space',
          status: 'nope',
          findings: [{ title: 'x', severity: 'ultra', status: 'bad' }],
        },
      ],
    })
    const host = graph.hosts[0]!
    expect(host.zone).toBe('external')
    expect(host.status).toBe('queued')
    expect(host.findings[0]!.severity).toBe('info')
    expect(host.findings[0]!.status).toBe('suspected')
  })
})

describe('mutators', () => {
  test('upsertHost adds then merges without losing findings', () => {
    let g = createEngagementGraph('t')
    g = upsertHost(g, { id: 'h1', label: 'Web', zone: 'external' })
    g = addFinding(g, 'h1', {
      title: 'RCE',
      severity: 'critical',
      status: 'exploited',
    })
    const before = g
    g = upsertHost(g, { id: 'h1', status: 'compromised' })
    expect(g.hosts[0]!.status).toBe('compromised')
    expect(g.hosts[0]!.findings).toHaveLength(1) // merge kept findings
    expect(before.hosts[0]!.status).toBe('queued') // immutability: original untouched
    expect(before.hosts[0]!.zone).toBe('external')
  })

  test('addFinding on a missing host is a no-op', () => {
    const g = upsertHost(createEngagementGraph(), { id: 'h1' })
    const same = addFinding(g, 'ghost', {
      title: 'x',
      severity: 'low',
      status: 'suspected',
    })
    expect(same).toBe(g)
  })

  test('upsertEdge rejects edges to unknown hosts and updates in place', () => {
    let g = createEngagementGraph()
    g = upsertHost(g, { id: 'a' })
    g = upsertHost(g, { id: 'b' })
    g = upsertEdge(g, { from: 'a', to: 'b', kind: 'pivot', label: 'SMB' })
    g = upsertEdge(g, { from: 'a', to: 'ghost', kind: 'route' })
    expect(g.edges).toHaveLength(1)
    g = upsertEdge(g, { from: 'a', to: 'b', kind: 'pivot', label: 'SMB 445' })
    expect(g.edges).toHaveLength(1) // same (from,to,kind) updated, not appended
    expect(g.edges[0]!.label).toBe('SMB 445')
  })
})

describe('summarizeEngagement / formatEngagementStatus', () => {
  test('reports absent when empty', () => {
    const s = summarizeEngagement(createEngagementGraph())
    expect(s.present).toBe(false)
    expect(formatEngagementStatus(s)).toContain('no hosts mapped')
  })

  test('counts zones, statuses, severities, exploited and active targets', () => {
    let g = createEngagementGraph('demo')
    g = upsertHost(g, {
      id: 'w',
      label: 'web',
      zone: 'external',
      status: 'testing',
      progress: 60,
    })
    g = upsertHost(g, {
      id: 'dc',
      label: 'DC',
      zone: 'internal',
      status: 'scanning',
      progress: 20,
    })
    g = upsertHost(g, {
      id: 'db',
      label: 'db',
      zone: 'internal',
      status: 'queued',
    })
    g = upsertHost(g, {
      id: 'fw',
      label: 'edge-fw',
      zone: 'dmz',
      kind: 'network-device',
      deviceType: 'firewall',
      status: 'idle',
    })
    g = addFinding(g, 'w', {
      title: 'a',
      severity: 'critical',
      status: 'exploited',
    })
    g = addFinding(g, 'dc', {
      title: 'b',
      severity: 'high',
      status: 'confirmed',
    })
    const s = summarizeEngagement(g)
    expect(s.hosts).toBe(4)
    expect(s.devices).toBe(1)
    expect(s.byZone).toMatchObject({ external: 1, internal: 2, dmz: 1 })
    expect(s.byStatus).toMatchObject({
      testing: 1,
      scanning: 1,
      queued: 1,
      idle: 1,
    })
    expect(s.findings).toBe(2)
    expect(s.bySeverity.critical).toBe(1)
    expect(s.exploited).toBe(1)
    expect(s.activeTargets.sort()).toEqual(['DC 20%', 'web 60%'])
    expect(s.avgProgress).toBe(20)
    expect(formatEngagementStatus(s)).toContain('4 nodes')
    expect(formatEngagementStatus(s)).toContain('1 net-dev')
  })

  test('setHostProgress updates progress/activity without losing findings', () => {
    let g = createEngagementGraph()
    g = upsertHost(g, { id: 'h1', label: 'web', status: 'scanning' })
    g = addFinding(g, 'h1', {
      title: 'x',
      severity: 'low',
      status: 'suspected',
    })
    g = setHostProgress(g, 'h1', 75, 'nuclei templates', 'testing')
    expect(g.hosts[0]!.progress).toBe(75)
    expect(g.hosts[0]!.activity).toBe('nuclei templates')
    expect(g.hosts[0]!.status).toBe('testing')
    expect(g.hosts[0]!.findings).toHaveLength(1)
  })
})
