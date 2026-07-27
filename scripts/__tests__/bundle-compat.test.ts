import { describe, expect, test } from 'bun:test'
import { patchNodeFetchWithNativeFetch } from '../bundle-compat'

describe('bundle compatibility rewrites', () => {
  test('replaces CommonJS and ESM node-fetch fallbacks', () => {
    const source = [
      'var fetchV2 = __importDefault(__require("node-fetch"));',
      'const fetchV3 = (await import("node-fetch")).default;',
    ].join('\n')

    const result = patchNodeFetchWithNativeFetch(source)

    expect(result.patched).toBe(2)
    expect(result.content).not.toContain('node-fetch')
    expect(result.content).toContain(
      '{ default: globalThis.fetch.bind(globalThis) }',
    )
    expect(result.content).toContain(
      'globalThis.fetch.bind(globalThis)',
    )
  })

  test('leaves unrelated bundle content unchanged', () => {
    const source = 'const value = await import("./chunk.js")'

    expect(patchNodeFetchWithNativeFetch(source)).toEqual({
      content: source,
      patched: 0,
    })
  })
})
