import { describe, expect, test } from 'bun:test'
import {
  buildPublicProxyEgressConfig,
  dedupeAndCapProxies,
  parsePublicProxyListBody,
  publicProxyToNode,
  scrapePublicProxies,
  type ParsedPublicProxy,
} from '../publicProxyPool'

describe('parsePublicProxyListBody', () => {
  test('extracts host:port pairs and infers socks5 from the source url', () => {
    const body = ['1.2.3.4:8080', '5.6.7.8:1080', 'not-a-proxy', '9.9.9.9:9999'].join(
      '\n',
    )
    const parsed = parsePublicProxyListBody(
      body,
      'https://example.test/socks5.txt',
    )
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toMatchObject({
      host: '1.2.3.4',
      port: 8080,
      protocol: 'socks5',
    })
  })

  test('dedupes identical endpoints inside one body', () => {
    const body = '1.2.3.4:8080\n1.2.3.4:8080\n1.2.3.4:8080'
    expect(parsePublicProxyListBody(body, 'http://x/http.txt')).toHaveLength(1)
  })
})

describe('dedupeAndCapProxies / publicProxyToNode', () => {
  test('caps at the requested limit and builds valid nodes', () => {
    const raw: ParsedPublicProxy[] = Array.from({ length: 20 }, (_, i) => ({
      host: `10.0.0.${i + 1}`,
      port: 8000 + i,
      protocol: 'http' as const,
      source: 't',
    }))
    // throw in a duplicate
    raw.push({ ...raw[0]! })
    const kept = dedupeAndCapProxies(raw, 10)
    expect(kept).toHaveLength(10)
    const node = publicProxyToNode(kept[0]!, 0)
    expect(node.endpoint).toBe('http://10.0.0.1:8000')
    expect(node.enabled).toBe(true)
    expect(node.provider).toBe('public-free-list')
  })
})

describe('buildPublicProxyEgressConfig', () => {
  test('marks the pool authorized via user opt-in and allows public free proxies', () => {
    const nodes = [
      publicProxyToNode(
        { host: '1.1.1.1', port: 8080, protocol: 'http', source: 't' },
        0,
      ),
    ]
    const config = buildPublicProxyEgressConfig(nodes)
    expect(config.policy.disallowPublicFreeProxies).toBe(false)
    expect(config.policy.requireAuthorization).toBe(true)
    expect(config.egressPools[0]!.authorization?.reference).toContain(
      'FIRST-RUN',
    )
    expect(config.egressPools[0]!.nodes).toHaveLength(1)
  })
})

describe('scrapePublicProxies', () => {
  test('aggregates multiple injected sources and respects limit', async () => {
    const result = await scrapePublicProxies({
      sources: [
        'https://example.test/http.txt',
        'https://example.test/socks5.txt',
      ],
      limit: 3,
      fetchText: async url => {
        if (url.includes('socks5')) {
          return { ok: true, body: '8.8.8.8:1080\n8.8.4.4:1080' }
        }
        return { ok: true, body: '1.1.1.1:8080\n1.0.0.1:8080\n9.9.9.9:8080' }
      },
    })
    expect(result.sourcesOk).toBe(2)
    expect(result.kept).toBe(3)
    expect(result.nodes).toHaveLength(3)
    expect(result.errors).toHaveLength(0)
  })

  test('records source errors without throwing', async () => {
    const result = await scrapePublicProxies({
      sources: ['https://dead.example/list'],
      limit: 10,
      fetchText: async () => ({ ok: false, error: 'timeout' }),
    })
    expect(result.sourcesOk).toBe(0)
    expect(result.kept).toBe(0)
    expect(result.errors[0]).toContain('timeout')
  })
})
