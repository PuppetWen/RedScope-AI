import { describe, expect, test } from 'bun:test'
import {
  beginEgressStep,
  createEgressRotationState,
  formatEgressStatus,
  markEgressSwitch,
  normalizeEgressConfig,
  parseEgressEndpoint,
  poolIsAuthorized,
  recordEgressResult,
  resolveEgressPool,
  saveEgressRotationState,
  selectAndPersistEgressNode,
  selectEgressNode,
  shouldSwitchEgress,
  summarizeEgress,
  type EgressConfig,
} from '../egressPool'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function makeConfig(overrides?: {
  requireAuthorization?: boolean
  authorized?: boolean
  nodeCount?: number
  maxAutoSwitchesPerStep?: number
}): EgressConfig {
  const nodeCount = overrides?.nodeCount ?? 3
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `node-${i + 1}`,
    endpoint: `http://10.0.0.${i + 1}:8080`,
    sourceIp: `10.0.0.${i + 1}`,
    enabled: true,
  }))
  return normalizeEgressConfig({
    schemaVersion: 1,
    policy: {
      requireAuthorization: overrides?.requireAuthorization ?? true,
      maxAutoSwitchesPerStep: overrides?.maxAutoSwitchesPerStep ?? 8,
      switchOnHttpStatuses: [403, 429],
      avoidPreviouslyUsedNodesPerTarget: true,
      blockedCooldownHours: 24,
      defaultPoolId: 'pool-a',
    },
    egressPools: [
      {
        id: 'pool-a',
        name: 'Pool A',
        authorization:
          (overrides?.authorized ?? true)
            ? { authorizedBy: 'Referee', reference: 'REF-1' }
            : undefined,
        nodes,
      },
    ],
  })
}

describe('parseEgressEndpoint', () => {
  test('parses supported proxy protocols with explicit ports', () => {
    expect(parseEgressEndpoint('http://8.138.125.130:80')).toEqual({
      protocol: 'http',
      host: '8.138.125.130',
      port: 80,
    })
    expect(parseEgressEndpoint('socks5://203.25.208.163:1111')).toEqual({
      protocol: 'socks5',
      host: '203.25.208.163',
      port: 1111,
    })
  })

  test('rejects unsupported schemes, missing ports, and bad ports', () => {
    expect(parseEgressEndpoint('ftp://1.2.3.4:21')).toBeNull()
    expect(parseEgressEndpoint('http://1.2.3.4')).toBeNull()
    expect(parseEgressEndpoint('http://1.2.3.4:70000')).toBeNull()
    expect(parseEgressEndpoint('not-a-url')).toBeNull()
  })
})

describe('normalizeEgressConfig', () => {
  test('drops malformed nodes but keeps valid ones', () => {
    const config = normalizeEgressConfig({
      policy: {},
      egressPools: [
        {
          id: 'pool-a',
          nodes: [
            { id: 'good', endpoint: 'http://1.2.3.4:80' },
            { id: 'bad-endpoint', endpoint: 'nonsense' },
            { endpoint: 'http://5.6.7.8:80' }, // missing id
          ],
        },
      ],
    })
    expect(config.egressPools[0]!.nodes.map(n => n.id)).toEqual(['good'])
  })

  test('treats absent enabled as enabled, false as disabled', () => {
    const config = normalizeEgressConfig({
      policy: {},
      egressPools: [
        {
          id: 'p',
          nodes: [
            { id: 'a', endpoint: 'http://1.1.1.1:80' },
            { id: 'b', endpoint: 'http://2.2.2.2:80', enabled: false },
          ],
        },
      ],
    })
    const [a, b] = config.egressPools[0]!.nodes
    expect(a!.enabled).toBe(true)
    expect(b!.enabled).toBe(false)
  })
})

describe('selectEgressNode', () => {
  test('refuses an unauthorized pool when policy requires authorization', () => {
    const config = makeConfig({ authorized: false })
    const state = createEgressRotationState()
    const outcome = selectEgressNode({ config, state, nowMs: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('unauthorized')
  })

  test('rotates least-recently-used across distinct nodes', () => {
    const config = makeConfig({ nodeCount: 3 })
    const state = createEgressRotationState()
    const first = selectEgressNode({ config, state, nowMs: 10 })
    const second = selectEgressNode({ config, state, nowMs: 20 })
    const third = selectEgressNode({ config, state, nowMs: 30 })
    const ids = [first, second, third].map(o => (o.ok ? o.node.id : null))
    expect(new Set(ids).size).toBe(3) // all distinct — real rotation
    // Fourth wraps back to the first-used node (now the least recent).
    const fourth = selectEgressNode({ config, state, nowMs: 40 })
    expect(fourth.ok).toBe(true)
    if (fourth.ok) expect(fourth.node.id).toBe(ids[0]!)
  })

  test('avoids nodes already used against the same target', () => {
    const config = makeConfig({ nodeCount: 2 })
    const state = createEgressRotationState()
    const a = selectEgressNode({
      config,
      state,
      target: 'host-1',
      nowMs: 10,
    })
    const b = selectEgressNode({
      config,
      state,
      target: 'host-1',
      nowMs: 20,
    })
    expect(a.ok && b.ok && a.node.id !== b.node.id).toBe(true)
  })

  test('skips blocked nodes and reports all-blocked', () => {
    const config = makeConfig({ nodeCount: 1 })
    const state = createEgressRotationState()
    recordEgressResult({
      policy: config.policy,
      state,
      nodeId: 'node-1',
      ok: false,
      nowMs: 0,
    })
    const outcome = selectEgressNode({ config, state, nowMs: 1000 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('all-blocked')
  })
})

describe('switch policy', () => {
  test('switches only on allowlisted statuses within the per-step cap', () => {
    const config = makeConfig({ maxAutoSwitchesPerStep: 2 })
    const state = beginEgressStep(createEgressRotationState(), 0)
    expect(
      shouldSwitchEgress({ policy: config.policy, httpStatus: 200, state }),
    ).toBe(false)
    expect(
      shouldSwitchEgress({ policy: config.policy, httpStatus: 429, state }),
    ).toBe(true)
    markEgressSwitch(state)
    markEgressSwitch(state)
    expect(
      shouldSwitchEgress({ policy: config.policy, httpStatus: 429, state }),
    ).toBe(false) // cap reached
  })

  test('a blocking status marks the node even when the request "ok"', () => {
    const config = makeConfig()
    const state = createEgressRotationState()
    recordEgressResult({
      policy: config.policy,
      state,
      nodeId: 'node-1',
      ok: true,
      httpStatus: 403,
      nowMs: 0,
    })
    expect(state.nodes['node-1']!.blockedUntilMs).toBeGreaterThan(0)
    expect(state.nodes['node-1']!.failureCount).toBe(1)
  })
})

describe('summarizeEgress / formatEgressStatus', () => {
  test('reports not-configured when there is no config', () => {
    const summary = summarizeEgress({
      config: null,
      state: createEgressRotationState(),
      nowMs: 0,
    })
    expect(summary.configured).toBe(false)
    expect(formatEgressStatus(summary)).toContain('not configured')
  })

  test('summarizes active node, counts, and authorization', () => {
    const config = makeConfig({ nodeCount: 3 })
    const state = createEgressRotationState()
    selectEgressNode({ config, state, nowMs: 10 })
    const summary = summarizeEgress({ config, state, nowMs: 20 })
    expect(summary).toMatchObject({
      configured: true,
      authorized: true,
      totalNodes: 3,
      enabledNodes: 3,
    })
    expect(summary.activeIp).toBeTruthy()
    expect(formatEgressStatus(summary)).toContain('authorized')
  })
})

describe('resolveEgressPool / poolIsAuthorized', () => {
  test('honors defaultPoolId then falls back to first pool', () => {
    const config = makeConfig()
    expect(resolveEgressPool(config)!.id).toBe('pool-a')
    expect(resolveEgressPool(config, 'missing')!.id).toBe('pool-a')
  })

  test('poolIsAuthorized requires an authorization reference', () => {
    const config = makeConfig({ authorized: false })
    expect(poolIsAuthorized(config.egressPools[0]!)).toBe(false)
  })
})

describe('saveEgressRotationState / selectAndPersistEgressNode', () => {
  test('persists rotation state to disk and reloads active node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redscope-egress-'))
    const statePath = join(dir, 'state.json')
    try {
      const config = makeConfig({ nodeCount: 2 })
      const state = createEgressRotationState()
      const outcome = selectAndPersistEgressNode({
        config,
        state,
        statePath,
        nowMs: 50,
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.persisted).toBe(true)
      const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
      expect(raw.activeNodeId).toBe(outcome.ok ? outcome.node.id : undefined)
      const saved = saveEgressRotationState(statePath, state)
      expect(saved.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
