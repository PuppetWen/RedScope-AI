import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearOpenAIClientCache, getOpenAIClient } from '../client.js'

describe('getOpenAIClient', () => {
  const envKeys = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'REDSCOPE_AUTH_TOKEN',
    'REDSCOPE_API_KEY',
    'REDSCOPE_BASE_URL',
  ] as const
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    clearOpenAIClientCache()
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    clearOpenAIClientCache()
    for (const key of envKeys) {
      const value = savedEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test('uses OPENAI_* credentials first', () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    process.env.OPENAI_BASE_URL = 'https://openai.example/v1'
    process.env.REDSCOPE_AUTH_TOKEN = 'redscope-key'
    process.env.REDSCOPE_BASE_URL = 'https://redscope.example/v1'

    const client = getOpenAIClient({ fetchOverride: globalThis.fetch })

    expect(client.apiKey).toBe('openai-key')
    expect(client.baseURL).toBe('https://openai.example/v1')
  })

  test('falls back to generic REDSCOPE_* credentials', () => {
    process.env.REDSCOPE_AUTH_TOKEN = 'redscope-key'
    process.env.REDSCOPE_BASE_URL = 'https://api.deepseek.com'

    const client = getOpenAIClient({ fetchOverride: globalThis.fetch })

    expect(client.apiKey).toBe('redscope-key')
    expect(client.baseURL).toBe('https://api.deepseek.com')
  })

  test('falls back to REDSCOPE_API_KEY when REDSCOPE_AUTH_TOKEN is absent', () => {
    process.env.REDSCOPE_API_KEY = 'redscope-api-key'

    const client = getOpenAIClient({ fetchOverride: globalThis.fetch })

    expect(client.apiKey).toBe('redscope-api-key')
  })
})
