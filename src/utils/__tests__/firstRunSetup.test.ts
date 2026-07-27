import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultFirstRunState,
  executeFirstRunChoice,
  formatFirstRunStatus,
  getFirstRunPrompt,
  loadFirstRunState,
  saveFirstRunState,
} from '../firstRunSetup'
import { buildPublicProxyEgressConfig, savePublicProxyPool, publicProxyToNode } from '../publicProxyPool'

let prevHome: string | undefined
let prevCwd: string
let dir: string

describe('firstRunSetup', () => {
  beforeEach(() => {
    prevCwd = process.cwd()
    prevHome = process.env.REDSCOPE_CONFIG_DIR
    dir = mkdtempSync(join(tmpdir(), 'redscope-firstrun-'))
    process.env.REDSCOPE_CONFIG_DIR = dir
    process.chdir(dir)
    mkdirSync(join(dir), { recursive: true })
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevHome === undefined) delete process.env.REDSCOPE_CONFIG_DIR
    else process.env.REDSCOPE_CONFIG_DIR = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  test('getFirstRunPrompt is needed when no state exists', () => {
    const prompt = getFirstRunPrompt()
    expect(prompt.needed).toBe(true)
    expect(prompt.reason).toBe('first-run')
    expect(prompt.options.length).toBe(4)
  })

  test('executeFirstRunChoice no persists a declined state', async () => {
    const result = await executeFirstRunChoice('no')
    expect(result.state.completedAt).toBeTruthy()
    expect(result.state.scrapeProxies).toBe(false)
    expect(result.state.collectPocs).toBe(false)
    const loaded = loadFirstRunState()
    expect(loaded?.completedAt).toBeTruthy()
    expect(getFirstRunPrompt().needed).toBe(false)
  })

  test('executeFirstRunChoice proxies-only uses injected scraper', async () => {
    const result = await executeFirstRunChoice('proxies-only', {
      refreshProxies: async () => {
        const nodes = [
          publicProxyToNode(
            { host: '1.2.3.4', port: 8080, protocol: 'http', source: 't' },
            0,
          ),
        ]
        const config = buildPublicProxyEgressConfig(nodes)
        savePublicProxyPool(config)
        return {
          result: {
            fetchedAt: new Date().toISOString(),
            sourcesAttempted: 1,
            sourcesOk: 1,
            rawParsed: 1,
            unique: 1,
            kept: 1,
            nodes,
            errors: [],
          },
          config,
        }
      },
    })
    expect(result.state.scrapeProxies).toBe(true)
    expect(result.state.collectPocs).toBe(false)
    expect(result.proxy?.kept).toBe(1)
    expect(result.logs.some(l => /Proxy pool ready/.test(l))).toBe(true)
  })

  test('formatFirstRunStatus renders pending and completed forms', () => {
    expect(formatFirstRunStatus(null)).toMatch(/pending/i)
    const state = defaultFirstRunState()
    state.completedAt = '2026-07-27T00:00:00Z'
    state.scrapeProxies = true
    state.proxyCount = 500
    state.collectPocs = true
    state.pocCount = 128
    saveFirstRunState(state)
    expect(formatFirstRunStatus(loadFirstRunState())).toMatch(/proxies=500/)
  })
})
