/**
 * Search adapter factory. Explicit WEB_SEARCH_ADAPTER values select one
 * backend; the default auto mode builds a resilient fallback chain.
 */

import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { FallbackSearchAdapter } from './fallbackAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

function isThirdPartyProvider(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)
  )
}

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: string | null = null

export function createAdapter(): WebSearchAdapter {
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  const adapterKey =
    envAdapter === 'api' || envAdapter === 'bing' || envAdapter === 'brave' || envAdapter === 'exa'
      ? envAdapter
      : createAutoAdapterKey()

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  if (adapterKey === 'api') {
    cachedAdapter = new ApiSearchAdapter()
    cachedAdapterKey = 'api'
    return cachedAdapter
  }
  if (adapterKey === 'brave') {
    cachedAdapter = new BraveSearchAdapter()
    cachedAdapterKey = 'brave'
    return cachedAdapter
  }
  if (adapterKey === 'exa') {
    cachedAdapter = new ExaSearchAdapter()
    cachedAdapterKey = 'exa'
    return cachedAdapter
  }
  if (adapterKey.startsWith('auto:')) {
    cachedAdapter = new FallbackSearchAdapter(createAutoAdapters())
    cachedAdapterKey = adapterKey
    return cachedAdapter
  }

  cachedAdapter = new BingSearchAdapter()
  cachedAdapterKey = 'bing'
  return cachedAdapter
}

function createAutoAdapters(): WebSearchAdapter[] {
  const adapters: WebSearchAdapter[] = []

  if (!isThirdPartyProvider() && isFirstPartyAnthropicBaseUrl()) {
    adapters.push(new ApiSearchAdapter())
  }

  adapters.push(new ExaSearchAdapter())

  if (hasBraveApiKey()) {
    adapters.push(new BraveSearchAdapter())
  }

  adapters.push(new BingSearchAdapter())
  return adapters
}

function hasBraveApiKey(): boolean {
  return !!(
    process.env.BRAVE_SEARCH_API_KEY?.trim() ||
    process.env.BRAVE_API_KEY?.trim()
  )
}

function createAutoAdapterKey(): string {
  const providerKind = isThirdPartyProvider() ? 'third-party' : 'first-party'
  const baseUrlKind = isFirstPartyAnthropicBaseUrl() ? 'official' : 'custom'
  const braveKind = hasBraveApiKey() ? 'brave' : 'no-brave'
  return `auto:${providerKind}:${baseUrlKind}:${braveKind}`
}
