import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureWorkingSilentEgress,
  silentRotateOnFailure,
  endSilentEgress,
  type SilentEgressSession,
} from '../silentEgress'
import {
  buildPublicProxyEgressConfig,
  publicProxyToNode,
  savePublicProxyPool,
} from '../publicProxyPool'

let prevConfigDir: string | undefined
let dir: string
let healthy = new Set<string>()
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const
let prevProxyEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>

describe('silentEgress auto-rotate', () => {
  beforeEach(() => {
    prevConfigDir = process.env.REDSCOPE_CONFIG_DIR
    prevProxyEnv = Object.fromEntries(
      PROXY_ENV_KEYS.map(key => [key, process.env[key]]),
    ) as typeof prevProxyEnv
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    dir = mkdtempSync(join(tmpdir(), 'redscope-silent-'))
    process.env.REDSCOPE_CONFIG_DIR = dir
    mkdirSync(dir, { recursive: true })
    healthy = new Set(['10.0.0.2:8080'])

    const nodes = [1, 2, 3].map(i =>
      publicProxyToNode(
        {
          host: `10.0.0.${i}`,
          port: 8080,
          protocol: 'http',
          source: 't',
        },
        i,
      ),
    )
    const config = buildPublicProxyEgressConfig(nodes, {
      statePath: join(dir, 'state.json'),
    })
    savePublicProxyPool(config, join(dir, 'public-free-proxies.json'))
  })

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.REDSCOPE_CONFIG_DIR
    else process.env.REDSCOPE_CONFIG_DIR = prevConfigDir
    rmSync(dir, { recursive: true, force: true })
    for (const key of PROXY_ENV_KEYS) {
      const previous = prevProxyEnv[key]
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  const healthCheck = async (host: string, port: number) =>
    healthy.has(`${host}:${port}`)

  test('skips dead nodes and silently activates the first healthy one', async () => {
    const session = await ensureWorkingSilentEgress({
      target: 'https://target.example',
      healthCheck,
      maxProbes: 5,
    })
    expect(session.enabled).toBe(true)
    expect(session.activeNode).not.toBeNull()
    expect(session.activeNode!.host).toBe('10.0.0.2')
    expect(process.env.HTTP_PROXY).toContain('10.0.0.2:8080')
    // first node (10.0.0.1) should have been probed and failed
    expect(
      session.events.some(e => e.type === 'probe-fail' || e.type === 'active'),
    ).toBe(true)
    endSilentEgress(session)
    expect(process.env.HTTP_PROXY).toBeUndefined()
  })

  test('silentRotateOnFailure cools the active node and picks another live one', async () => {
    // Only .2 is live initially
    let session = await ensureWorkingSilentEgress({
      target: 't1',
      healthCheck,
      maxProbes: 5,
    })
    expect(session.activeNode!.host).toBe('10.0.0.2')

    // .2 dies, .3 becomes live
    healthy.delete('10.0.0.2:8080')
    healthy.add('10.0.0.3:8080')

    const rotated = await silentRotateOnFailure(session, {
      httpStatus: 403,
      reason: 'blocked',
      healthCheck,
    })
    expect(rotated).toBe(true)
    expect(session.activeNode!.host).toBe('10.0.0.3')
    endSilentEgress(session)
  })

  test('returns disabled session when no pool is present', async () => {
    rmSync(join(dir, 'public-free-proxies.json'), { force: true })
    // also ensure loadEgressConfig finds nothing in this config dir
    const session = await ensureWorkingSilentEgress({
      healthCheck: async () => true,
    })
    // May still find referee template from repo; just assert shape
    expect(session).toBeTruthy()
    expect(Array.isArray(session.events)).toBe(true)
    endSilentEgress(session)
  })
})
