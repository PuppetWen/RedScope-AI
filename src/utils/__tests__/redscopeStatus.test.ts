import { describe, expect, test } from 'bun:test'
import {
  buildAutonomyAvailability,
  buildRedscopeCompactStatusRows,
  buildRedscopeStatusRows,
  formatElapsed,
  formatRedscopeStatusLines,
  shouldShowRedscopeStatusHud,
  type RedscopeStatusModel,
} from '../redscopeStatus'
import { summarizeEgress, createEgressRotationState } from '../egressPool'
import { summarizeEngagement } from '../engagementGraph'
import { summarizePocCatalog } from '../pocCatalog'

function baseModel(
  overrides?: Partial<RedscopeStatusModel>,
): RedscopeStatusModel {
  return {
    goal: null,
    autonomy: { available: true, reason: null },
    egress: summarizeEgress({
      config: null,
      state: createEgressRotationState(),
      nowMs: 0,
    }),
    engagement: summarizeEngagement(null),
    poc: summarizePocCatalog(null),
    firstRun: {
      needed: false,
      completed: false,
      proxyCount: 0,
      pocCount: 0,
    },
    nuclei: null,
    ...overrides,
  }
}

describe('buildAutonomyAvailability', () => {
  test('available only when gate enabled and no reason', () => {
    expect(buildAutonomyAvailability(true, null).available).toBe(true)
    expect(buildAutonomyAvailability(true, 'model').available).toBe(false)
    expect(buildAutonomyAvailability(false, null).available).toBe(false)
  })
})

describe('shouldShowRedscopeStatusHud', () => {
  test('shows during entry setup messages and hides after a real turn', () => {
    expect(shouldShowRedscopeStatusHud([])).toBe(true)
    expect(
      shouldShowRedscopeStatusHud([
        { type: 'system' },
        { type: 'progress' },
        { type: 'attachment' },
      ]),
    ).toBe(true)
    expect(shouldShowRedscopeStatusHud([{ type: 'user' }])).toBe(false)
    expect(shouldShowRedscopeStatusHud([{ type: 'assistant' }])).toBe(false)
  })
})

describe('formatElapsed', () => {
  test('formats seconds, minutes, hours and clamps negatives', () => {
    expect(formatElapsed(-100)).toBe('0s')
    expect(formatElapsed(5_000)).toBe('5s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
    expect(formatElapsed(3_725_000)).toBe('1h 2m')
  })
})

describe('buildRedscopeStatusRows', () => {
  test('omits subsystems with no state, always shows autonomy', () => {
    const rows = buildRedscopeStatusRows(baseModel())
    const ids = rows.map(r => r.id)
    expect(ids).toEqual(['autonomy'])
  })

  test('renders a goal row with iteration and elapsed', () => {
    const rows = buildRedscopeStatusRows(
      baseModel({
        goal: { objective: 'own the DC', iterations: 3, elapsedMs: 65_000 },
      }),
    )
    const goal = rows.find(r => r.id === 'goal')!
    expect(goal.value).toContain('own the DC')
    expect(goal.value).toContain('iter 3')
    expect(goal.value).toContain('1m 5s')
  })

  test('flags an unauthorized egress pool as danger', () => {
    const model = baseModel({
      egress: {
        configured: true,
        poolId: 'p',
        poolName: 'Pool',
        authorized: false,
        totalNodes: 5,
        enabledNodes: 4,
        blockedNodes: 1,
        activeIp: '10.0.0.1',
        switchesThisStep: 2,
        maxAutoSwitchesPerStep: 8,
      },
    })
    const egress = buildRedscopeStatusRows(model).find(r => r.id === 'egress')!
    expect(egress.tone).toBe('danger')
    expect(egress.value).toContain('1 cooling')
  })

  test('marks recon danger when there are exploited/critical findings', () => {
    const model = baseModel({
      engagement: {
        present: true,
        hosts: 3,
        devices: 1,
        byZone: { external: 1, dmz: 0, internal: 2 },
        byStatus: {
          queued: 1,
          scanning: 0,
          testing: 1,
          compromised: 1,
          clean: 0,
          idle: 0,
        },
        findings: 2,
        bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
        exploited: 1,
        edges: 2,
        activeTargets: ['DC01 42%'],
        avgProgress: 42,
      },
    })
    const rows = buildRedscopeStatusRows(model)
    expect(rows.find(r => r.id === 'recon')!.tone).toBe('danger')
    expect(rows.find(r => r.id === 'recon')!.value).toContain('1 net-dev')
    expect(rows.find(r => r.id === 'recon')!.value).toContain('avg 42%')
    expect(rows.find(r => r.id === 'targets')!.value).toBe('DC01 42%')
  })
})

describe('buildRedscopeCompactStatusRows', () => {
  test('groups high-signal state into bounded conversation rows', () => {
    const model = baseModel({
      autonomy: { available: false, reason: 'model' },
      engagement: {
        present: true,
        hosts: 3,
        devices: 1,
        byZone: { external: 1, dmz: 0, internal: 2 },
        byStatus: {
          queued: 1,
          scanning: 0,
          testing: 1,
          compromised: 1,
          clean: 0,
          idle: 0,
        },
        findings: 2,
        bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
        exploited: 1,
        edges: 2,
        activeTargets: ['DC01 42%'],
        avgProgress: 42,
      },
      egress: {
        configured: true,
        poolId: 'p',
        poolName: 'Pool',
        authorized: true,
        totalNodes: 5,
        enabledNodes: 4,
        blockedNodes: 1,
        activeIp: '10.0.0.1',
        switchesThisStep: 2,
        maxAutoSwitchesPerStep: 8,
      },
      poc: {
        present: true,
        total: 128,
        scopeGated: 128,
        bySeverity: {
          critical: 1,
          high: 2,
          medium: 0,
          low: 0,
          unknown: 0,
        },
        categories: ['rce'],
      },
      firstRun: {
        needed: true,
        completed: false,
        proxyCount: 5,
        pocCount: 128,
      },
      nuclei: { available: false, source: 'missing' },
    })

    const rows = buildRedscopeCompactStatusRows(model)
    expect(rows.map(row => row.id)).toEqual([
      'operation',
      'network',
      'capabilities',
    ])
    expect(rows[0]!.value).toContain('1 critical')
    expect(rows[1]!.value).toContain('1 cooling')
    expect(rows[2]!.value).toContain('128 PoCs')
    expect(rows[2]!.value).toContain('Nuclei missing')
  })

  test('does not invent network or capability rows without state', () => {
    expect(
      buildRedscopeCompactStatusRows(baseModel()).map(row => row.id),
    ).toEqual(['operation'])
  })
})

describe('formatRedscopeStatusLines', () => {
  test('produces one prefixed line per row', () => {
    const lines = formatRedscopeStatusLines(
      baseModel({
        goal: { objective: 'x', iterations: 0, elapsedMs: 0 },
      }),
    )
    expect(lines.some(l => l.startsWith('◎ Goal:'))).toBe(true)
    expect(lines.some(l => l.startsWith('⚡ Autonomy:'))).toBe(true)
  })
})
