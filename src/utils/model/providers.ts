import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getInitialSettings } from '../settings/settings.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'grok'

export function getAPIProvider(): APIProvider {
  const modelType = getInitialSettings().modelType
  if (modelType === 'openai') return 'openai'
  if (modelType === 'gemini') return 'gemini'
  if (modelType === 'grok') return 'grok'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return 'openai'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) return 'gemini'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)) return 'grok'

  const redscopeProvider = getRedScopeProviderFromEnv()
  if (redscopeProvider) return redscopeProvider

  return 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  // TODO: 这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

function getRedScopeProviderFromEnv(): APIProvider | null {
  const provider = normalizeProviderName(
    process.env.REDSCOPE_MODEL_PROVIDER ?? process.env.MODEL_PROVIDER ?? '',
  )

  if (provider) {
    if (provider === 'anthropic' || provider === 'firstparty') {
      return 'firstParty'
    }
    if (
      provider === 'openai' ||
      provider === 'openai-compatible' ||
      provider === 'deepseek' ||
      provider === 'glm' ||
      provider === 'zhipu' ||
      provider === 'zai' ||
      provider === 'kimi' ||
      provider === 'moonshot' ||
      provider === 'minimax' ||
      provider === 'qwen' ||
      provider === 'dashscope'
    ) {
      return 'openai'
    }
    if (provider === 'gemini') return 'gemini'
    if (provider === 'grok' || provider === 'xai') return 'grok'
    if (provider.endsWith('-anthropic')) return 'firstParty'
  }

  if (
    process.env.REDSCOPE_BASE_URL ||
    process.env.REDSCOPE_AUTH_TOKEN ||
    process.env.REDSCOPE_API_KEY ||
    process.env.REDSCOPE_MODEL ||
    process.env.REDSCOPE_DEFAULT_OPUS_MODEL ||
    process.env.REDSCOPE_DEFAULT_SONNET_MODEL ||
    process.env.REDSCOPE_DEFAULT_HAIKU_MODEL
  ) {
    return 'openai'
  }

  return null
}

function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase().replace(/_/g, '-')
}
