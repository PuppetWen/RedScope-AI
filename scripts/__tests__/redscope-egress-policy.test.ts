import { describe, expect, test } from 'bun:test'
import {
  selectNextEgressNode,
  validateEgressConfig,
} from '../redscope-egress-policy.ts'

const activeWindow = new Date('2026-05-20T12:00:00Z')

function baseConfig() {
  return {
    generatedAt: '2026-05-20',
    policy: {
      requireAuthorization: true,
      disallowPublicFreeProxies: true,
      disallowUnverifiedNodes: true,
      defaultRefreshIntervalDays: 1,
    },
    egressPools: [
      {
        id: 'authorized',
        name: 'Authorized Egress',
        owner: 'Example Corp',
        authorization: {
          authorizedBy: 'Jane Doe',
          reference: 'ENG-2026-EGRESS-001',
          validFrom: '2026-05-18',
          validTo: '2026-06-18',
          emergencyContact: 'security@example.com',
        },
        allowedTargets: {
          domains: ['example.com'],
          ips: ['192.0.2.10'],
          cidrs: ['198.51.100.0/24'],
        },
        rateLimits: {
          requestsPerSecond: 1,
          concurrency: 1,
        },
        nodes: [
          {
            id: 'vpn-1',
            kind: 'corporate-egress',
            endpoint: 'socks5://proxy.example.com:1080',
            sourceIp: '203.0.113.10',
            ownershipEvidence: 'ENG-2026-EGRESS-001',
            authEnv: 'REDSCOPE_EXAMPLE_EGRESS_AUTH',
          },
          {
            id: 'vpn-2',
            kind: 'cloud-egress',
            endpoint: 'http://proxy2.example.com:8080',
            sourceIp: '203.0.113.11',
            ownershipEvidence: 'ENG-2026-EGRESS-001',
            authEnv: 'REDSCOPE_EXAMPLE_EGRESS_AUTH',
          },
        ],
      },
    ],
  }
}

describe('validateEgressConfig', () => {
  test('accepts authorized owned egress nodes for scoped targets', () => {
    const result = validateEgressConfig(baseConfig(), {
      now: activeWindow,
      target: 'https://app.example.com/login',
    })

    expect(result.status).toBe('ok')
    expect(result.canUse).toBe(true)
    expect(result.pools[0].enabledNodeCount).toBe(2)
  })

  test('rejects public free proxy source signals', () => {
    const config = baseConfig()
    config.egressPools[0].nodes[0] = {
      id: 'free-node',
      kind: 'public-free-proxy',
      endpoint: 'http://198.51.100.9:8080',
      ownershipEvidence: 'none',
      sourceUrl: 'https://www.zdaye.com/free/',
    } as (typeof config.egressPools)[0]['nodes'][0]

    const result = validateEgressConfig(config, { now: activeWindow })

    expect(result.status).toBe('error')
    expect(
      result.issues.some(issue =>
        issue.message.includes('public/free proxy source signals'),
      ),
    ).toBe(true)
  })

  test('rejects targets outside the authorized egress scope', () => {
    const result = validateEgressConfig(baseConfig(), {
      now: activeWindow,
      target: 'https://not-example.test/',
    })

    expect(result.status).toBe('error')
    expect(
      result.issues.some(issue =>
        issue.message.includes('is not authorized for this egress pool'),
      ),
    ).toBe(true)
  })

  test('rejects raw proxy credentials in endpoint URLs', () => {
    const config = baseConfig()
    config.egressPools[0].nodes[0].endpoint =
      'http://user:password@proxy.example.com:8080'

    const result = validateEgressConfig(config, { now: activeWindow })

    expect(result.status).toBe('error')
    expect(
      result.issues.some(issue =>
        issue.message.includes('do not put proxy credentials'),
      ),
    ).toBe(true)
  })

  test('accepts referee-approved proxy nodes with broad referee target approval', () => {
    const config = baseConfig()
    config.egressPools[0].allowedTargets = { any: true }
    config.egressPools[0].nodes[0].kind = 'referee-approved-proxy'

    const result = validateEgressConfig(config, {
      now: activeWindow,
      target: 'https://outside-example.test/',
    })

    expect(result.status).toBe('ok')
    expect(result.canUse).toBe(true)
  })

  test('selects the next approved node after the current node is blocked', () => {
    const plan = selectNextEgressNode(
      baseConfig(),
      {
        schemaVersion: 1,
        updatedAt: activeWindow.toISOString(),
        blockedNodes: [
          {
            poolId: 'authorized',
            nodeId: 'vpn-1',
            target: 'https://app.example.com/login',
            statusCode: 403,
            reason: 'target-side block',
            blockedAt: activeWindow.toISOString(),
            blockedUntil: '2026-05-21T12:00:00.000Z',
          },
        ],
      },
      {
        poolId: 'authorized',
        currentNodeId: 'vpn-1',
        target: 'https://app.example.com/login',
        now: activeWindow,
      },
    )

    expect(plan.nextNode?.id).toBe('vpn-2')
    expect(plan.message).toContain('vpn-2')
  })

  test('skips source IPs already used for the same target', () => {
    const config = baseConfig()
    config.egressPools[0].nodes[0].sourceIp = '203.0.113.10'
    config.egressPools[0].nodes[1].sourceIp = '203.0.113.10'
    config.egressPools[0].nodes.push({
      id: 'vpn-3',
      kind: 'cloud-egress',
      endpoint: 'http://proxy3.example.com:8080',
      sourceIp: '203.0.113.12',
      ownershipEvidence: 'ENG-2026-EGRESS-001',
      authEnv: 'REDSCOPE_EXAMPLE_EGRESS_AUTH',
    })

    const plan = selectNextEgressNode(
      config,
      {
        schemaVersion: 1,
        updatedAt: activeWindow.toISOString(),
        blockedNodes: [],
        usedNodes: [
          {
            poolId: 'authorized',
            nodeId: 'vpn-1',
            target: 'https://app.example.com/login',
            sourceIp: '203.0.113.10',
            endpointHost: 'proxy.example.com',
            firstUsedAt: activeWindow.toISOString(),
            lastUsedAt: activeWindow.toISOString(),
            useCount: 1,
          },
        ],
      },
      {
        poolId: 'authorized',
        currentNodeId: 'vpn-1',
        target: 'https://app.example.com/login',
        now: activeWindow,
        avoidUsedForTarget: true,
      },
    )

    expect(plan.nextNode?.id).toBe('vpn-3')
  })
})
