import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:net'
import { describe, expect, test } from 'bun:test'
import {
  createAuthorizedEgressSession,
  recordBlockAndSwitchAuthorizedEgress,
  restoreAuthorizedEgressEnv,
} from '../redscope-egress-runtime.ts'

const proxyEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'REDSCOPE_AUTO_EGRESS',
  'REDSCOPE_AUTO_EGRESS_CONFIG',
  'REDSCOPE_EGRESS_STATE',
  'REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS',
] as const

function captureEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of proxyEnvKeys) env[key] = process.env[key]
  return env
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const key of proxyEnvKeys) {
    const value = env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function listenTcpServer(): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(socket => {
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port')
  }
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
  }
}

async function closeTcpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function runtimeConfig(
  statePath: string,
  endpoints: { node1: string; node2: string },
) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-20',
    policy: {
      requireAuthorization: true,
      disallowPublicFreeProxies: true,
      disallowUnverifiedNodes: true,
      autoUseForAuthorizedTesting: true,
      defaultPoolId: 'referee',
      defaultRefreshIntervalDays: 1,
      blockedCooldownHours: 24,
      validateBeforeUse: true,
      connectivityCheckTimeoutMs: 500,
      avoidPreviouslyUsedNodesPerTarget: true,
      statePath,
    },
    egressPools: [
      {
        id: 'referee',
        name: 'Referee',
        owner: 'Exercise Referee',
        authorization: {
          authorizedBy: 'Exercise Referee',
          reference: 'REF-1',
          validFrom: '2026-05-20',
          validTo: '2030-06-20',
          emergencyContact: 'referee',
        },
        allowedTargets: { any: true },
        rateLimits: { requestsPerSecond: 1, concurrency: 1 },
        nodes: [
          {
            id: 'node-1',
            kind: 'referee-approved-proxy',
            endpoint: endpoints.node1,
            sourceIp: '198.51.100.1',
            ownershipEvidence: 'REF-1',
          },
          {
            id: 'node-2',
            kind: 'referee-approved-proxy',
            endpoint: endpoints.node2,
            sourceIp: '198.51.100.2',
            ownershipEvidence: 'REF-1',
          },
        ],
      },
    ],
  }
}

describe('redscope authorized egress runtime', () => {
  test('selects and switches referee-approved nodes without prompting', async () => {
    const originalEnv = captureEnv()
    const dir = await mkdtemp(join(tmpdir(), 'redscope-egress-runtime-'))
    const configPath = join(dir, 'egress.json')
    const statePath = join(dir, 'state.json')
    const server1 = await listenTcpServer()
    const server2 = await listenTcpServer()
    let session: Awaited<ReturnType<typeof createAuthorizedEgressSession>> | undefined

    try {
      await writeFile(
        configPath,
        `${JSON.stringify(
          runtimeConfig(statePath, {
            node1: server1.endpoint,
            node2: server2.endpoint,
          }),
          null,
          2,
        )}\n`,
      )
      process.env.REDSCOPE_AUTO_EGRESS = '1'
      process.env.REDSCOPE_AUTO_EGRESS_CONFIG = configPath
      process.env.REDSCOPE_EGRESS_STATE = statePath
      process.env.REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS = '500'

      session = await createAuthorizedEgressSession('https://target.example/')

      expect(session.enabled).toBe(true)
      expect(session.currentNode?.id).toBe('node-1')
      expect(session.validateBeforeUse).toBe(true)
      expect(session.avoidUsedForTarget).toBe(true)
      expect(process.env.HTTP_PROXY).toBe(server1.endpoint)

      const switched = await recordBlockAndSwitchAuthorizedEgress(session, {
        statusCode: 403,
        reason: 'target-side block',
      })

      expect(switched).toBe(true)
      expect(session.currentNode?.id).toBe('node-2')
      expect(process.env.HTTP_PROXY).toBe(server2.endpoint)

      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        blockedNodes: Array<{ nodeId: string }>
        usedNodes: Array<{ nodeId: string; target?: string; sourceIp?: string }>
      }
      expect(state.blockedNodes[0]?.nodeId).toBe('node-1')
      expect(state.usedNodes.map(record => record.nodeId)).toEqual([
        'node-1',
        'node-2',
      ])
      expect(state.usedNodes[0]?.sourceIp).toBe('198.51.100.1')
    } finally {
      restoreAuthorizedEgressEnv(session)
      restoreEnv(originalEnv)
      await closeTcpServer(server1.server)
      await closeTcpServer(server2.server)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
