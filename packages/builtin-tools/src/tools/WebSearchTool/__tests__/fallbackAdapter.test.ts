import { describe, expect, mock, test } from 'bun:test'
import { FallbackSearchAdapter } from '../adapters/fallbackAdapter'
import type { WebSearchAdapter } from '../adapters/types'

describe('FallbackSearchAdapter', () => {
  test('uses the next adapter when the first backend fails', async () => {
    const first = adapterRejecting(new Error('backend unavailable'))
    const second = adapterResolving([
      { title: 'Docs', url: 'https://example.com/docs' },
    ])

    const adapter = new FallbackSearchAdapter([first, second])
    const results = await adapter.search('docs', {})

    expect(results).toEqual([
      { title: 'Docs', url: 'https://example.com/docs' },
    ])
  })

  test('does not retry aborted searches', async () => {
    const { AbortError } = await import('src/utils/errors.js')
    const first = adapterRejecting(new AbortError())
    const second = adapterResolving([
      { title: 'Should not run', url: 'https://example.com/never' },
    ])

    const adapter = new FallbackSearchAdapter([first, second])
    await expect(adapter.search('docs', {})).rejects.toThrow(AbortError)
  })
})

function adapterRejecting(error: Error): WebSearchAdapter {
  return {
    search: mock(() => Promise.reject(error)),
  }
}

function adapterResolving(results: Awaited<ReturnType<WebSearchAdapter['search']>>): WebSearchAdapter {
  return {
    search: mock(() => Promise.resolve(results)),
  }
}
