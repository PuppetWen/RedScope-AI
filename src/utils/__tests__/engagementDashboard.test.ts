import { describe, expect, test } from 'bun:test'
import { renderEngagementDashboardHtml } from '../engagementDashboard'
import {
  addFinding,
  createEngagementGraph,
  upsertEdge,
  upsertHost,
} from '../engagementGraph'

function demoGraph() {
  let g = createEngagementGraph('Demo Range')
  g = upsertHost(g, {
    id: 'web',
    label: 'edge-web',
    ip: '203.0.113.10',
    zone: 'external',
    status: 'compromised',
  })
  g = upsertHost(g, {
    id: 'dc',
    label: 'DC01',
    ip: '10.0.0.5',
    zone: 'internal',
    status: 'testing',
    role: 'domain-controller',
  })
  g = addFinding(g, 'web', {
    title: 'Struts RCE',
    severity: 'critical',
    status: 'exploited',
    cve: 'CVE-2017-5638',
  })
  g = upsertEdge(g, { from: 'web', to: 'dc', kind: 'pivot', label: 'SMB 445' })
  return g
}

describe('renderEngagementDashboardHtml', () => {
  test('produces a self-contained document with the graph embedded', () => {
    const html = renderEngagementDashboardHtml(demoGraph(), {
      generatedAt: '2026-07-26',
    })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<svg id="graph"')
    expect(html).toContain('Targets under test')
    expect(html).toContain('Findings feed')
    expect(html).toContain('Selected node')
    expect(html).toContain('network device')
    // progress UI appears in the client script / CSS (bar, pct-label, ring)
    expect(html).toContain('pct-label')
    // engagement data embedded for offline (file://) viewing
    expect(html).toContain('CVE-2017-5638')
    expect(html).toContain('id="engagement-data"')
    // no external resource loads (the SVG namespace URI is not a network fetch)
    expect(html).not.toMatch(/(?:src|href)=["']https?:/)
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script src')
  })

  test('renders network-device diamonds and progress fields from the graph', () => {
    let g = createEngagementGraph('Devices')
    g = upsertHost(g, {
      id: 'fw',
      label: 'edge-fw',
      kind: 'network-device',
      deviceType: 'firewall',
      zone: 'external',
      status: 'idle',
    })
    g = upsertHost(g, {
      id: 'web',
      label: 'web',
      zone: 'external',
      status: 'testing',
      progress: 42,
      activity: 'nuclei',
    })
    g = upsertEdge(g, {
      from: 'web',
      to: 'fw',
      kind: 'transit',
      label: 'ACL',
    })
    const html = renderEngagementDashboardHtml(g)
    expect(html).toContain('edge-fw')
    expect(html).toContain('network-device')
    expect(html).toContain('"progress":42')
    expect(html).toContain('transit')
  })

  test('escapes a </script> breakout attempt inside data', () => {
    let g = createEngagementGraph('x')
    g = upsertHost(g, { id: 'h', label: '</script><script>alert(1)</script>' })
    const html = renderEngagementDashboardHtml(g)
    // The payload is escaped, so it cannot introduce an extra </script>.
    // The document emits exactly three script tags (data, bootstrap, IIFE).
    expect(html.match(/<\/script>/g)!.length).toBe(3)
    expect(html).toContain('\\u003c/script\\u003e')
  })

  test('contains no raw line/paragraph separators (JS syntax hazard)', () => {
    const html = renderEngagementDashboardHtml(demoGraph())
    const raw = [...html].filter(
      ch => ch === '\u2028' || ch === '\u2029',
    ).length
    expect(raw).toBe(0)
  })
})
