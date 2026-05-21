/**
 * Default mapping from Anthropic model names to OpenAI model names.
 * Used only when ANTHROPIC_DEFAULT_*_MODEL env vars are not set.
 */
const DEFAULT_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'gpt-4o',
  'claude-sonnet-4-5-20250929': 'gpt-4o',
  'claude-sonnet-4-6': 'gpt-4o',
  'claude-opus-4-20250514': 'o3',
  'claude-opus-4-1-20250805': 'o3',
  'claude-opus-4-5-20251101': 'o3',
  'claude-opus-4-6': 'o3',
  'claude-haiku-4-5-20251001': 'gpt-4o-mini',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  'claude-3-7-sonnet-20250219': 'gpt-4o',
  'claude-3-5-sonnet-20241022': 'gpt-4o',
}

function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

/**
 * Resolve the OpenAI model name for a given Anthropic model.
 *
 * Priority:
 * 1. OPENAI_MODEL env var (override all)
 * 2. REDSCOPE_MODEL env var (RedScope generic override)
 * 3. OPENAI_DEFAULT_{FAMILY}_MODEL env var (e.g. OPENAI_DEFAULT_SONNET_MODEL)
 * 4. REDSCOPE_DEFAULT_{FAMILY}_MODEL env var (RedScope generic family override)
 * 5. ANTHROPIC_DEFAULT_{FAMILY}_MODEL env var (backward compatibility)
 * 6. DEFAULT_MODEL_MAP lookup
 * 7. Pass through original model name
 */
export function resolveOpenAIModel(anthropicModel: string): string {
  if (process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL
  }
  if (process.env.REDSCOPE_MODEL) {
    return process.env.REDSCOPE_MODEL
  }

  const cleanModel = anthropicModel.replace(/\[1m\]$/, '')

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride

    const redscopeEnvVar = `REDSCOPE_DEFAULT_${family.toUpperCase()}_MODEL`
    const redscopeOverride = process.env[redscopeEnvVar]
    if (redscopeOverride) return redscopeOverride

    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return anthropicOverride
  }

  return DEFAULT_MODEL_MAP[cleanModel] ?? cleanModel
}
