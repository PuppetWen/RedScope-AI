import { afterEach, describe, expect, mock, test } from 'bun:test'

let isFirstPartyBaseUrl = true

// Only mock the external dependency that controls adapter selection
mock.module('src/utils/model/providers.js', () => ({
  isFirstPartyAnthropicBaseUrl: () => isFirstPartyBaseUrl,
  getAPIProvider: () => 'firstParty',
  getAPIProviderForStatsig: () => 'firstParty',
}))

const { createAdapter } = await import('../adapters/index')

const originalWebSearchAdapter = process.env.WEB_SEARCH_ADAPTER
const originalOpenAIFlag = process.env.CLAUDE_CODE_USE_OPENAI
const originalGeminiFlag = process.env.CLAUDE_CODE_USE_GEMINI
const originalGrokFlag = process.env.CLAUDE_CODE_USE_GROK
const originalBraveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY
const originalBraveApiKey = process.env.BRAVE_API_KEY

afterEach(() => {
  isFirstPartyBaseUrl = true

  restoreEnv('WEB_SEARCH_ADAPTER', originalWebSearchAdapter)
  restoreEnv('CLAUDE_CODE_USE_OPENAI', originalOpenAIFlag)
  restoreEnv('CLAUDE_CODE_USE_GEMINI', originalGeminiFlag)
  restoreEnv('CLAUDE_CODE_USE_GROK', originalGrokFlag)
  restoreEnv('BRAVE_SEARCH_API_KEY', originalBraveSearchApiKey)
  restoreEnv('BRAVE_API_KEY', originalBraveApiKey)
})

describe('createAdapter', () => {
  test('reuses the same instance when the selected backend does not change', () => {
    process.env.WEB_SEARCH_ADAPTER = 'brave'

    const firstAdapter = createAdapter()
    const secondAdapter = createAdapter()

    expect(firstAdapter).toBe(secondAdapter)
    expect(firstAdapter.constructor.name).toBe('BraveSearchAdapter')
  })

  test('rebuilds the adapter when WEB_SEARCH_ADAPTER changes', () => {
    process.env.WEB_SEARCH_ADAPTER = 'brave'
    const braveAdapter = createAdapter()

    process.env.WEB_SEARCH_ADAPTER = 'bing'
    const bingAdapter = createAdapter()

    expect(bingAdapter).not.toBe(braveAdapter)
    expect(bingAdapter.constructor.name).toBe('BingSearchAdapter')
  })

  test('uses an auto fallback chain for first-party Anthropic URLs', () => {
    delete process.env.WEB_SEARCH_ADAPTER
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY
    isFirstPartyBaseUrl = true

    const adapter = createAdapter()
    expect(adapter.constructor.name).toBe('FallbackSearchAdapter')
    expect(adapterNames(adapter)).toEqual([
      'ApiSearchAdapter',
      'ExaSearchAdapter',
      'BingSearchAdapter',
    ])
  })

  test('auto fallback starts with Exa for third-party providers', () => {
    delete process.env.WEB_SEARCH_ADAPTER
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY
    isFirstPartyBaseUrl = false

    const adapter = createAdapter()
    expect(adapter.constructor.name).toBe('FallbackSearchAdapter')
    expect(adapterNames(adapter)).toEqual([
      'ExaSearchAdapter',
      'BingSearchAdapter',
    ])
  })

  test('auto fallback does not treat string zero provider flags as enabled', () => {
    delete process.env.WEB_SEARCH_ADAPTER
    process.env.CLAUDE_CODE_USE_OPENAI = '0'
    process.env.CLAUDE_CODE_USE_GEMINI = '0'
    process.env.CLAUDE_CODE_USE_GROK = '0'
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY
    isFirstPartyBaseUrl = true

    expect(adapterNames(createAdapter())[0]).toBe('ApiSearchAdapter')
  })

  test('auto fallback includes Brave when an API key is configured', () => {
    delete process.env.WEB_SEARCH_ADAPTER
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    process.env.BRAVE_API_KEY = 'test-key'
    isFirstPartyBaseUrl = false

    expect(adapterNames(createAdapter())).toEqual([
      'ExaSearchAdapter',
      'BraveSearchAdapter',
      'BingSearchAdapter',
    ])
  })
})

function adapterNames(adapter: unknown): string[] {
  const withAdapters = adapter as {
    adapters?: Array<{ constructor: { name: string } }>
  }
  return withAdapters.adapters?.map(inner => inner.constructor.name) ?? []
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
