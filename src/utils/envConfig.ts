import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  getPreferredUserConfigFile,
  getUserConfigFiles,
  uniquePaths,
} from './redscopeCompat.js'
import { isProviderManagedEnvVar } from './managedEnvConstants.js'
import { ensureUserRefereeEgressConfigFile } from './authorizedEgressConfig.js'

export const ENV_CONFIG_FILE = 'env.config'
const LEGACY_DOTENV_FILE = '.env'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const RUNTIME_MODEL_CONFIG_KEYS = new Set([
  'REDSCOPE_MODEL_PROVIDER',
  'REDSCOPE_BASE_URL',
  'REDSCOPE_AUTH_TOKEN',
  'REDSCOPE_API_KEY',
  'REDSCOPE_MODEL',
  'REDSCOPE_DEFAULT_OPUS_MODEL',
  'REDSCOPE_DEFAULT_SONNET_MODEL',
  'REDSCOPE_DEFAULT_HAIKU_MODEL',
  'REDSCOPE_SUBAGENT_MODEL',
  'REDSCOPE_EFFORT_LEVEL',
  'REDSCOPE_SMALL_FAST_MODEL',
  'MODEL_PROVIDER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'GLM_API_KEY',
  'GLM_BASE_URL',
  'GLM_MODEL',
  'ZHIPU_API_KEY',
  'ZHIPUAI_API_KEY',
  'ZHIPUAI_BASE_URL',
  'ZHIPU_MODEL',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'ZAI_MODEL',
  'BIGMODEL_API_KEY',
  'BIGMODEL_BASE_URL',
  'BIGMODEL_MODEL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'KIMI_MODEL',
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  'MOONSHOT_MODEL',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_BASE_URL',
  'DASHSCOPE_MODEL',
])

type OpenAICompatiblePreset = {
  baseUrl: string
  apiKeyVars: string[]
  baseUrlVars: string[]
  modelVars: string[]
  defaultModel: string
  normalizeBaseUrl?: (baseUrl: string) => string
}

const OPENAI_COMPATIBLE_PRESETS: Record<string, OpenAICompatiblePreset> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyVars: ['DEEPSEEK_API_KEY'],
    baseUrlVars: ['DEEPSEEK_BASE_URL'],
    modelVars: ['DEEPSEEK_MODEL'],
    defaultModel: 'deepseek-chat',
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyVars: [
      'GLM_API_KEY',
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
      'ZAI_API_KEY',
      'BIGMODEL_API_KEY',
    ],
    baseUrlVars: [
      'GLM_BASE_URL',
      'ZHIPUAI_BASE_URL',
      'ZAI_BASE_URL',
      'BIGMODEL_BASE_URL',
    ],
    modelVars: ['GLM_MODEL', 'ZHIPU_MODEL', 'ZAI_MODEL', 'BIGMODEL_MODEL'],
    defaultModel: 'glm-5.1',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyVars: [
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
      'GLM_API_KEY',
      'ZAI_API_KEY',
      'BIGMODEL_API_KEY',
    ],
    baseUrlVars: [
      'ZHIPUAI_BASE_URL',
      'GLM_BASE_URL',
      'ZAI_BASE_URL',
      'BIGMODEL_BASE_URL',
    ],
    modelVars: ['ZHIPU_MODEL', 'GLM_MODEL', 'ZAI_MODEL', 'BIGMODEL_MODEL'],
    defaultModel: 'glm-5.1',
  },
  zai: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyVars: [
      'ZAI_API_KEY',
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
      'GLM_API_KEY',
      'BIGMODEL_API_KEY',
    ],
    baseUrlVars: [
      'ZAI_BASE_URL',
      'ZHIPUAI_BASE_URL',
      'GLM_BASE_URL',
      'BIGMODEL_BASE_URL',
    ],
    modelVars: ['ZAI_MODEL', 'ZHIPU_MODEL', 'GLM_MODEL', 'BIGMODEL_MODEL'],
    defaultModel: 'glm-5.1',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrlVars: ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
    modelVars: ['KIMI_MODEL', 'MOONSHOT_MODEL'],
    defaultModel: 'kimi-k2.6',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    baseUrlVars: ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
    modelVars: ['MOONSHOT_MODEL', 'KIMI_MODEL'],
    defaultModel: 'kimi-k2.6',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyVars: ['MINIMAX_API_KEY'],
    baseUrlVars: ['MINIMAX_BASE_URL'],
    modelVars: ['MINIMAX_MODEL'],
    defaultModel: 'MiniMax-M2.7',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    baseUrlVars: ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL'],
    modelVars: ['QWEN_MODEL', 'DASHSCOPE_MODEL'],
    defaultModel: 'qwen-max',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    baseUrlVars: ['DASHSCOPE_BASE_URL', 'QWEN_BASE_URL'],
    modelVars: ['DASHSCOPE_MODEL', 'QWEN_MODEL'],
    defaultModel: 'qwen-max',
  },
}

const PROVIDER_ALIASES: Record<string, string> = {
  bigmodel: 'glm',
  'big-model': 'glm',
  zhipuai: 'zhipu',
  'zhipu-ai': 'zhipu',
  'z-ai': 'zai',
  moonshotai: 'moonshot',
  'moonshot-ai': 'moonshot',
  mini: 'minimax',
  'mini-max': 'minimax',
  alibaba: 'qwen',
  tongyi: 'qwen',
}

let envConfigCache: Record<string, string> | undefined

export function resetEnvConfigCache(): void {
  envConfigCache = undefined
}

export function getEnvConfigFilePaths(): string[] {
  return getUserConfigFiles(ENV_CONFIG_FILE)
}

export function getPreferredEnvConfigFilePath(): string {
  return getPreferredUserConfigFile(ENV_CONFIG_FILE)
}

export function parseEnvConfig(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex <= 0) continue

    const key = assignment.slice(0, equalsIndex).trim()
    if (!ENV_KEY_PATTERN.test(key)) continue

    const rawValue = assignment.slice(equalsIndex + 1).trim()
    env[key] = parseEnvConfigValue(rawValue)
  }

  return env
}

export function getEnvConfigEnvironment(): Record<string, string> {
  if (envConfigCache) {
    return { ...envConfigCache }
  }

  ensureEnvConfigFile()
  ensureUserRefereeEgressConfigFile()

  const merged: Record<string, string> = {}
  for (const filePath of getReadableEnvConfigFiles()) {
    Object.assign(merged, parseEnvConfig(readFileSync(filePath, 'utf-8')))
  }

  const expanded = expandEnvConfigEnvironment(merged)
  envConfigCache = expanded
  return { ...expanded }
}

export function applyEnvConfigEnvironmentVariables(): void {
  const processEnv = getProcessEnvStringRecord()
  const envConfig = getEnvConfigEnvironment()
  const expandedProcessEnv = expandEnvConfigEnvironment(processEnv)

  Object.assign(process.env, envConfig, processEnv, expandedProcessEnv)
}

export function updateEnvConfigValues(values: Record<string, string>): {
  error: Error | null
  filePath: string
} {
  const filePath = getPreferredEnvConfigFilePath()
  try {
    ensureEnvConfigFile()
    if (Object.keys(values).length === 0) {
      return { error: null, filePath }
    }
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    const updated = upsertEnvConfigContent(content, values)
    writeEnvConfigFile(filePath, updated)
    resetEnvConfigCache()
    Object.assign(process.env, values)
    return { error: null, filePath }
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      filePath,
    }
  }
}

export function pickRuntimeModelConfigValues(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}

  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (isRuntimeModelConfigKey(key)) {
      picked[key] = value
    }
  }
  return picked
}

export function migrateLegacyRuntimeModelConfigValues(
  values: Record<string, string> | undefined,
): boolean {
  const runtimeValues = pickRuntimeModelConfigValues(values)
  if (Object.keys(runtimeValues).length === 0) return false

  ensureEnvConfigFile()
  if (hasEnvConfigRuntimeModelValues()) return false

  return updateEnvConfigValues(runtimeValues).error === null
}

export function expandEnvConfigEnvironment(
  env: Record<string, string>,
): Record<string, string> {
  const expanded = { ...env }
  const provider = normalizeProviderName(
    env.REDSCOPE_MODEL_PROVIDER ?? env.MODEL_PROVIDER ?? '',
  )

  applyGenericRedScopeSessionAliases(expanded)

  if (!provider) {
    if (hasGenericRedScopeProviderConfig(expanded)) {
      applyGenericRedScopeOpenAICompatibleAliases(expanded)
    }
    return expanded
  }

  if (provider === 'anthropic' || provider === 'firstparty') {
    setIfMissing(expanded, 'CLAUDE_CODE_USE_OPENAI', '0')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GEMINI', '0')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GROK', '0')
    applyGenericRedScopeAnthropicAliases(expanded)
    return expanded
  }

  if (provider === 'openai' || provider === 'openai-compatible') {
    setOpenAIProviderFlags(expanded)
    applyGenericRedScopeOpenAICompatibleAliases(expanded)
    setIfMissing(expanded, 'OPENAI_BASE_URL', 'https://api.openai.com/v1')
    return expanded
  }

  if (provider === 'gemini') {
    setIfMissing(expanded, 'CLAUDE_CODE_USE_OPENAI', '0')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GEMINI', '1')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GROK', '0')
    applyGenericRedScopeGeminiAliases(expanded)
    return expanded
  }

  if (provider === 'grok' || provider === 'xai') {
    setIfMissing(expanded, 'CLAUDE_CODE_USE_OPENAI', '0')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GEMINI', '0')
    setIfMissing(expanded, 'CLAUDE_CODE_USE_GROK', '1')
    applyGenericRedScopeGrokAliases(expanded)
    return expanded
  }

  if (provider === 'deepseek-anthropic') {
    applyAnthropicCompatiblePreset(expanded, {
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKeyVars: ['DEEPSEEK_API_KEY'],
      baseUrlVars: ['DEEPSEEK_BASE_URL'],
      modelVars: ['DEEPSEEK_MODEL'],
      defaultModel: 'deepseek-chat',
      normalizeBaseUrl: normalizeDeepSeekAnthropicBaseUrl,
    })
    return expanded
  }

  if (provider === 'minimax-anthropic') {
    applyAnthropicCompatiblePreset(expanded, {
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKeyVars: ['MINIMAX_API_KEY'],
      baseUrlVars: ['MINIMAX_BASE_URL'],
      modelVars: ['MINIMAX_MODEL'],
      defaultModel: 'MiniMax-M2.7',
    })
    return expanded
  }

  const preset = OPENAI_COMPATIBLE_PRESETS[provider]
  if (preset) {
    applyOpenAICompatiblePreset(expanded, preset)
  }

  return expanded
}

function ensureEnvConfigFile(): void {
  if (getReadableEnvConfigFiles().length > 0) return

  const migrated = readLegacyDotEnvForMigration()
  const content =
    Object.keys(migrated).length > 0
      ? createEnvConfigTemplate(migrated, true)
      : createEnvConfigTemplate({}, false)

  writeEnvConfigFile(getPreferredEnvConfigFilePath(), content)
}

function getReadableEnvConfigFiles(): string[] {
  return uniquePaths(
    getEnvConfigFilePaths().filter(path => existsSync(path)),
  ).reverse()
}

function readLegacyDotEnvForMigration(): Record<string, string> {
  const merged: Record<string, string> = {}
  const files = uniquePaths(
    getUserConfigFiles(LEGACY_DOTENV_FILE).filter(path => existsSync(path)),
  ).reverse()

  for (const filePath of files) {
    Object.assign(merged, parseEnvConfig(readFileSync(filePath, 'utf-8')))
  }

  return merged
}

function parseEnvConfigValue(rawValue: string): string {
  if (!rawValue) return ''

  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    try {
      const parsed = JSON.parse(rawValue)
      if (typeof parsed === 'string') return parsed
    } catch {
      return rawValue.slice(1, -1)
    }
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1)
  }

  return rawValue
}

function upsertEnvConfigContent(
  content: string,
  values: Record<string, string>,
): string {
  const keys = new Set(Object.keys(values))
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const keptLines = lines.filter(line => {
    const key = getEnvAssignmentKey(line)
    return !key || !keys.has(key)
  })

  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') {
    keptLines.pop()
  }

  if (keptLines.length > 0) keptLines.push('')
  keptLines.push('# Saved by RedScope AI login/setup.')

  for (const [key, value] of Object.entries(values)) {
    if (!ENV_KEY_PATTERN.test(key)) continue
    keptLines.push(`${key}=${formatEnvConfigValue(value)}`)
  }

  return `${keptLines.join('\n')}\n`
}

function getEnvAssignmentKey(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const assignment = trimmed.startsWith('export ')
    ? trimmed.slice(7).trim()
    : trimmed
  const equalsIndex = assignment.indexOf('=')
  if (equalsIndex <= 0) return null

  const key = assignment.slice(0, equalsIndex).trim()
  return ENV_KEY_PATTERN.test(key) ? key : null
}

function formatEnvConfigValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+\-[\]]+$/.test(value)) {
    return value
  }
  return JSON.stringify(value)
}

function createEnvConfigTemplate(
  values: Record<string, string>,
  migratedFromDotEnv: boolean,
): string {
  const lines = [
    '# RedScope AI environment configuration.',
    '# This file is loaded from the user config directory at startup.',
    '# Keep secrets here instead of project .env files.',
    '',
    '# Recommended: choose exactly one provider preset below.',
    '# RedScope expands these presets into the existing OPENAI_*, GEMINI_*,',
    '# GROK_*, or ANTHROPIC_* runtime variables during startup.',
    '# REDSCOPE_MODEL_PROVIDER=openai',
    '# REDSCOPE_MODEL_PROVIDER=deepseek',
    '# REDSCOPE_MODEL_PROVIDER=glm',
    '# REDSCOPE_MODEL_PROVIDER=kimi',
    '# REDSCOPE_MODEL_PROVIDER=minimax',
    '# REDSCOPE_MODEL_PROVIDER=gemini',
    '# REDSCOPE_MODEL_PROVIDER=grok',
    '',
    '# Generic RedScope model variables (OpenAI-compatible by default when',
    '# REDSCOPE_MODEL_PROVIDER is not set):',
    '# REDSCOPE_BASE_URL=https://api.deepseek.com',
    '# REDSCOPE_AUTH_TOKEN=',
    '# REDSCOPE_MODEL=deepseek-v4-pro[1m]',
    '# REDSCOPE_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]',
    '# REDSCOPE_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]',
    '# REDSCOPE_DEFAULT_HAIKU_MODEL=deepseek-v4-flash',
    '# REDSCOPE_SUBAGENT_MODEL=deepseek-v4-flash',
    '# REDSCOPE_EFFORT_LEVEL=max',
    '',
    '# RedScope security tools/workflow defaults. JSON registries stay in',
    '# the project; env.config controls default paths and external metadata',
    '# providers for RedScope security-suite scripts. CLI flags still win.',
    '# REDSCOPE_TOOLS_ROOT: security tools root directory.',
    '# REDSCOPE_TOOLS_ROOT=tools',
    '# REDSCOPE_TOOLS_TOOL_REGISTRY: external tool registry JSON path.',
    '# REDSCOPE_TOOLS_TOOL_REGISTRY=tools/redscope-tool-registry.json',
    '# REDSCOPE_TOOLS_SOURCE_REGISTRY: quarantined source registry JSON path.',
    '# REDSCOPE_TOOLS_SOURCE_REGISTRY=tools/redscope-source-registry.json',
    '# REDSCOPE_TOOLS_PROFILE_REGISTRY: deterministic run profile registry path.',
    '# REDSCOPE_TOOLS_PROFILE_REGISTRY=tools/redscope-run-profiles.json',
    '# REDSCOPE_TOOLS_SOURCE_ROOT: extracted reference source/template root.',
    '# REDSCOPE_TOOLS_SOURCE_ROOT=tools/sources',
    '# REDSCOPE_TOOLS_SOURCE_CACHE_ROOT: cached source archive root.',
    '# REDSCOPE_TOOLS_SOURCE_CACHE_ROOT=tools/cache/sources',
    '# REDSCOPE_TOOLS_SOURCE_STATE: source update state manifest path.',
    '# REDSCOPE_TOOLS_SOURCE_STATE=tools/manifests/redscope-source-state.json',
    '# REDSCOPE_TOOLS_SOURCE_UPDATE_INTERVAL_DAYS: source refresh interval in days.',
    '# REDSCOPE_TOOLS_SOURCE_UPDATE_INTERVAL_DAYS=7',
    '# REDSCOPE_TOOLS_EGRESS_CONFIG: authorized egress config JSON path.',
    '# REDSCOPE_TOOLS_EGRESS_CONFIG=tools/authorized-egress.example.json',
    '# REDSCOPE_TOOLS_EGRESS_STATE: authorized egress runtime state path.',
    '# REDSCOPE_TOOLS_EGRESS_STATE=tools/manifests/redscope-egress-state.json',
    '# REDSCOPE_AUTO_EGRESS: 1 enables automatic authorized egress; 0 disables it.',
    '# REDSCOPE_AUTO_EGRESS=0',
    '# REDSCOPE_AUTO_EGRESS_CONFIG: config used when automatic egress is enabled.',
    '# RedScope creates authorized-egress.referee-provided.json next to this',
    '# env.config on first startup; edit that user-level copy for referee IPs.',
    '# REDSCOPE_AUTO_EGRESS_CONFIG=tools/authorized-egress.referee-provided.json',
    '# REDSCOPE_EGRESS_POOL: egress pool id from the authorized egress config.',
    '# REDSCOPE_EGRESS_POOL=referee-provided-traffic-simulation',
    '# REDSCOPE_EGRESS_MAX_SWITCHES: max automatic node switches per profile step.',
    '# REDSCOPE_EGRESS_MAX_SWITCHES=20',
    '# REDSCOPE_EGRESS_VALIDATE_CONNECTIVITY: 1 checks reachability before use.',
    '# REDSCOPE_EGRESS_VALIDATE_CONNECTIVITY=1',
    '# REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS: per-node reachability timeout.',
    '# REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS=3000',
    '# REDSCOPE_EGRESS_AVOID_USED_PER_TARGET: 1 avoids reusing source IP per target.',
    '# REDSCOPE_EGRESS_AVOID_USED_PER_TARGET=1',
    '# REDSCOPE_TOOLS_OUTPUT_ROOT: profile output root directory.',
    '# REDSCOPE_TOOLS_OUTPUT_ROOT=tools/outputs',
    '# REDSCOPE_TOOLS_MEMORY_ROOT: security-suite memory/summary root.',
    '# REDSCOPE_TOOLS_MEMORY_ROOT=tools/memory',
    '# REDSCOPE_TOOLS_DEFAULT_SCOPE: default authorized scope JSON path.',
    '# REDSCOPE_TOOLS_DEFAULT_SCOPE=tools/scope.json',
    '# REDSCOPE_TOOLS_EXTERNAL_POC_PROVIDERS: comma-separated metadata providers.',
    '# REDSCOPE_TOOLS_EXTERNAL_POC_PROVIDERS=github,bing,google,baidu',
    '# WEB_SEARCH_ADAPTER: search backend selector; auto chooses available backend.',
    '# WEB_SEARCH_ADAPTER=auto',
    '# BRAVE_SEARCH_API_KEY: Brave Search API key for metadata search.',
    '# BRAVE_SEARCH_API_KEY=',
    '# NVD_API_KEY: NVD API key, optional but improves rate limits.',
    '# NVD_API_KEY=',
    '',
    '# Generic OpenAI Chat Completions-compatible endpoint:',
    '# REDSCOPE_MODEL_PROVIDER=openai',
    '# OPENAI_BASE_URL=https://api.openai.com/v1',
    '# OPENAI_API_KEY=',
    '# OPENAI_MODEL=',
    '# OPENAI_DEFAULT_HAIKU_MODEL=',
    '# OPENAI_DEFAULT_SONNET_MODEL=',
    '# OPENAI_DEFAULT_OPUS_MODEL=',
    '',
    '# DeepSeek via OpenAI-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=deepseek',
    '# DEEPSEEK_API_KEY=',
    '# DEEPSEEK_BASE_URL=https://api.deepseek.com',
    '# DEEPSEEK_MODEL=deepseek-chat',
    '',
    '# DeepSeek via Anthropic-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=deepseek-anthropic',
    '# DEEPSEEK_API_KEY=',
    '# DEEPSEEK_BASE_URL=https://api.deepseek.com',
    '# RedScope expands the root DeepSeek URL to /anthropic for this preset.',
    '# DEEPSEEK_MODEL=deepseek-chat',
    '',
    '# GLM / Zhipu / Z.ai via OpenAI-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=glm',
    '# GLM_API_KEY=',
    '# GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
    '# GLM_MODEL=glm-5.1',
    '',
    '# Kimi / Moonshot via OpenAI-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=kimi',
    '# KIMI_API_KEY=',
    '# KIMI_BASE_URL=https://api.moonshot.cn/v1',
    '# KIMI_MODEL=kimi-k2.6',
    '',
    '# MiniMax via OpenAI-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=minimax',
    '# MINIMAX_API_KEY=',
    '# MINIMAX_BASE_URL=https://api.minimax.io/v1',
    '# MINIMAX_MODEL=MiniMax-M2.7',
    '',
    '# MiniMax via Anthropic-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=minimax-anthropic',
    '# MINIMAX_API_KEY=',
    '# MINIMAX_BASE_URL=https://api.minimax.io/anthropic',
    '# MINIMAX_MODEL=MiniMax-M2.7',
    '',
    '# Qwen / DashScope via OpenAI-compatible protocol:',
    '# REDSCOPE_MODEL_PROVIDER=qwen',
    '# DASHSCOPE_API_KEY=',
    '# DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1',
    '# DASHSCOPE_MODEL=qwen-max',
    '',
    '# Anthropic-compatible endpoint:',
    '# ANTHROPIC_BASE_URL=https://api.anthropic.com',
    '# ANTHROPIC_AUTH_TOKEN=',
    '# ANTHROPIC_DEFAULT_HAIKU_MODEL=',
    '# ANTHROPIC_DEFAULT_SONNET_MODEL=',
    '# ANTHROPIC_DEFAULT_OPUS_MODEL=',
    '',
    '# Gemini endpoint:',
    '# GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta',
    '# GEMINI_API_KEY=',
    '# GEMINI_MODEL=',
    '# GEMINI_DEFAULT_HAIKU_MODEL=',
    '# GEMINI_DEFAULT_SONNET_MODEL=',
    '# GEMINI_DEFAULT_OPUS_MODEL=',
    '',
    '# Grok endpoint:',
    '# GROK_BASE_URL=https://api.x.ai/v1',
    '# GROK_API_KEY=',
    '# GROK_MODEL=',
    '# GROK_DEFAULT_HAIKU_MODEL=',
    '# GROK_DEFAULT_SONNET_MODEL=',
    '# GROK_DEFAULT_OPUS_MODEL=',
  ]

  if (Object.keys(values).length > 0) {
    lines.push('')
    lines.push(
      migratedFromDotEnv
        ? '# Migrated from legacy .env in the RedScope config directory.'
        : '# Current values.',
    )
    for (const [key, value] of Object.entries(values)) {
      if (ENV_KEY_PATTERN.test(key)) {
        lines.push(`${key}=${formatEnvConfigValue(value)}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

function writeEnvConfigFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

function hasEnvConfigRuntimeModelValues(): boolean {
  const merged: Record<string, string> = {}
  for (const filePath of getReadableEnvConfigFiles()) {
    Object.assign(merged, parseEnvConfig(readFileSync(filePath, 'utf-8')))
  }
  return Object.keys(merged).some(isRuntimeModelConfigKey)
}

function isRuntimeModelConfigKey(key: string): boolean {
  const upper = key.toUpperCase()
  return RUNTIME_MODEL_CONFIG_KEYS.has(upper) || isProviderManagedEnvVar(upper)
}

function normalizeProviderName(provider: string): string {
  const normalized = provider.trim().toLowerCase().replace(/_/g, '-')
  return PROVIDER_ALIASES[normalized] ?? normalized
}

function applyOpenAICompatiblePreset(
  env: Record<string, string>,
  preset: OpenAICompatiblePreset,
): void {
  setOpenAIProviderFlags(env)
  setIfMissing(
    env,
    'OPENAI_BASE_URL',
    firstConfigured(env, ['REDSCOPE_BASE_URL', ...preset.baseUrlVars]) ??
      preset.baseUrl,
  )
  setIfMissing(
    env,
    'OPENAI_API_KEY',
    firstConfigured(env, [
      'REDSCOPE_AUTH_TOKEN',
      'REDSCOPE_API_KEY',
      ...preset.apiKeyVars,
    ]),
  )

  const model =
    firstConfigured(env, ['REDSCOPE_MODEL', ...preset.modelVars]) ??
    preset.defaultModel
  setIfMissing(env, 'OPENAI_MODEL', model)
  setIfMissing(
    env,
    'OPENAI_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? model,
  )
  setIfMissing(
    env,
    'OPENAI_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? model,
  )
  setIfMissing(
    env,
    'OPENAI_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? model,
  )
  setIfMissing(env, 'OPENAI_SMALL_FAST_MODEL', env.REDSCOPE_SMALL_FAST_MODEL)
}

function applyAnthropicCompatiblePreset(
  env: Record<string, string>,
  preset: OpenAICompatiblePreset,
): void {
  setIfMissing(env, 'CLAUDE_CODE_USE_OPENAI', '0')
  setIfMissing(env, 'CLAUDE_CODE_USE_GEMINI', '0')
  setIfMissing(env, 'CLAUDE_CODE_USE_GROK', '0')
  setIfMissing(
    env,
    'ANTHROPIC_BASE_URL',
    normalizePresetBaseUrl(
      firstConfigured(env, ['REDSCOPE_BASE_URL', ...preset.baseUrlVars]) ??
        preset.baseUrl,
      preset,
    ),
  )
  setIfMissing(
    env,
    'ANTHROPIC_AUTH_TOKEN',
    firstConfigured(env, [
      'REDSCOPE_AUTH_TOKEN',
      'REDSCOPE_API_KEY',
      ...preset.apiKeyVars,
    ]),
  )

  const model =
    firstConfigured(env, ['REDSCOPE_MODEL', ...preset.modelVars]) ??
    preset.defaultModel
  setIfMissing(env, 'ANTHROPIC_MODEL', model)
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? model,
  )
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? model,
  )
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? model,
  )
  setIfMissing(env, 'ANTHROPIC_SMALL_FAST_MODEL', env.REDSCOPE_SMALL_FAST_MODEL)
}

function normalizePresetBaseUrl(
  baseUrl: string,
  preset: OpenAICompatiblePreset,
): string {
  return preset.normalizeBaseUrl?.(baseUrl) ?? baseUrl
}

function normalizeDeepSeekAnthropicBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if (
      url.hostname.toLowerCase() === 'api.deepseek.com' &&
      (url.pathname === '' || url.pathname === '/')
    ) {
      url.pathname = '/anthropic'
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    return baseUrl
  }
  return baseUrl
}

function applyGenericRedScopeOpenAICompatibleAliases(
  env: Record<string, string>,
): void {
  setOpenAIProviderFlags(env)
  setIfMissing(env, 'OPENAI_BASE_URL', env.REDSCOPE_BASE_URL)
  setIfMissing(
    env,
    'OPENAI_API_KEY',
    firstConfigured(env, ['REDSCOPE_AUTH_TOKEN', 'REDSCOPE_API_KEY']),
  )
  setIfMissing(env, 'OPENAI_MODEL', env.REDSCOPE_MODEL)
  setIfMissing(
    env,
    'OPENAI_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'OPENAI_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'OPENAI_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(env, 'OPENAI_SMALL_FAST_MODEL', env.REDSCOPE_SMALL_FAST_MODEL)
}

function applyGenericRedScopeAnthropicAliases(
  env: Record<string, string>,
): void {
  setIfMissing(env, 'ANTHROPIC_BASE_URL', env.REDSCOPE_BASE_URL)
  setIfMissing(
    env,
    'ANTHROPIC_AUTH_TOKEN',
    firstConfigured(env, ['REDSCOPE_AUTH_TOKEN', 'REDSCOPE_API_KEY']),
  )
  setIfMissing(env, 'ANTHROPIC_MODEL', env.REDSCOPE_MODEL)
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(env, 'ANTHROPIC_SMALL_FAST_MODEL', env.REDSCOPE_SMALL_FAST_MODEL)
}

function applyGenericRedScopeGeminiAliases(env: Record<string, string>): void {
  setIfMissing(env, 'GEMINI_BASE_URL', env.REDSCOPE_BASE_URL)
  setIfMissing(
    env,
    'GEMINI_API_KEY',
    firstConfigured(env, ['REDSCOPE_AUTH_TOKEN', 'REDSCOPE_API_KEY']),
  )
  setIfMissing(env, 'GEMINI_MODEL', env.REDSCOPE_MODEL)
  setIfMissing(
    env,
    'GEMINI_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'GEMINI_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'GEMINI_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(env, 'GEMINI_SMALL_FAST_MODEL', env.REDSCOPE_SMALL_FAST_MODEL)
}

function applyGenericRedScopeGrokAliases(env: Record<string, string>): void {
  setIfMissing(env, 'GROK_BASE_URL', env.REDSCOPE_BASE_URL)
  setIfMissing(
    env,
    'GROK_API_KEY',
    firstConfigured(env, ['REDSCOPE_AUTH_TOKEN', 'REDSCOPE_API_KEY']),
  )
  setIfMissing(env, 'GROK_MODEL', env.REDSCOPE_MODEL)
  setIfMissing(
    env,
    'GROK_DEFAULT_HAIKU_MODEL',
    env.REDSCOPE_DEFAULT_HAIKU_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'GROK_DEFAULT_SONNET_MODEL',
    env.REDSCOPE_DEFAULT_SONNET_MODEL ?? env.REDSCOPE_MODEL,
  )
  setIfMissing(
    env,
    'GROK_DEFAULT_OPUS_MODEL',
    env.REDSCOPE_DEFAULT_OPUS_MODEL ?? env.REDSCOPE_MODEL,
  )
}

function applyGenericRedScopeSessionAliases(env: Record<string, string>): void {
  setIfMissing(env, 'CLAUDE_CODE_SUBAGENT_MODEL', env.REDSCOPE_SUBAGENT_MODEL)
  setIfMissing(env, 'CLAUDE_CODE_EFFORT_LEVEL', env.REDSCOPE_EFFORT_LEVEL)
}

function hasGenericRedScopeProviderConfig(
  env: Record<string, string>,
): boolean {
  return [
    'REDSCOPE_BASE_URL',
    'REDSCOPE_AUTH_TOKEN',
    'REDSCOPE_API_KEY',
    'REDSCOPE_MODEL',
    'REDSCOPE_DEFAULT_OPUS_MODEL',
    'REDSCOPE_DEFAULT_SONNET_MODEL',
    'REDSCOPE_DEFAULT_HAIKU_MODEL',
  ].some(key => Boolean(env[key]))
}

function getProcessEnvStringRecord(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

function setOpenAIProviderFlags(env: Record<string, string>): void {
  setIfMissing(env, 'CLAUDE_CODE_USE_OPENAI', '1')
  setIfMissing(env, 'CLAUDE_CODE_USE_GEMINI', '0')
  setIfMissing(env, 'CLAUDE_CODE_USE_GROK', '0')
}

function firstConfigured(
  env: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key]
    if (value) return value
  }
  return undefined
}

function setIfMissing(
  env: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined || value === '') return
  if (env[key] === undefined || env[key] === '') {
    env[key] = value
  }
}
