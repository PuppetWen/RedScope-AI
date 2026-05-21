import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyEnvConfigEnvironmentVariables,
  expandEnvConfigEnvironment,
  getEnvConfigEnvironment,
  getPreferredEnvConfigFilePath,
  migrateLegacyRuntimeModelConfigValues,
  parseEnvConfig,
  resetEnvConfigCache,
  updateEnvConfigValues,
} from '../envConfig'
import { getPreferredRefereeEgressConfigFilePath } from '../authorizedEgressConfig'

const TEST_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'QUOTED_VALUE',
  'LEGACY_KEY',
  'DUPLICATE_KEY',
  'REDSCOPE_MODEL_PROVIDER',
  'REDSCOPE_BASE_URL',
  'REDSCOPE_AUTH_TOKEN',
  'REDSCOPE_MODEL',
  'REDSCOPE_DEFAULT_HAIKU_MODEL',
  'REDSCOPE_DEFAULT_OPUS_MODEL',
  'REDSCOPE_DEFAULT_SONNET_MODEL',
  'REDSCOPE_SUBAGENT_MODEL',
  'REDSCOPE_EFFORT_LEVEL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
]

describe('envConfig', () => {
  let tempDir = ''
  let previousRedScopeConfigDir: string | undefined
  let previousClaudeConfigDir: string | undefined
  let previousValues: Record<string, string | undefined> = {}

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'redscope-env-config-'))
    previousRedScopeConfigDir = process.env.REDSCOPE_CONFIG_DIR
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousValues = {}
    for (const key of TEST_KEYS) {
      previousValues[key] = process.env[key]
      delete process.env[key]
    }
    process.env.REDSCOPE_CONFIG_DIR = join(tempDir, 'redscope')
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude')
    resetEnvConfigCache()
  })

  afterEach(() => {
    resetEnvConfigCache()
    if (previousRedScopeConfigDir === undefined) {
      delete process.env.REDSCOPE_CONFIG_DIR
    } else {
      process.env.REDSCOPE_CONFIG_DIR = previousRedScopeConfigDir
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
    for (const key of TEST_KEYS) {
      const value = previousValues[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('parses key-value lines, export prefixes, and quoted values', () => {
    const parsed = parseEnvConfig(`
# comment
OPENAI_API_KEY=plain
export OPENAI_BASE_URL=https://example.test/v1
QUOTED_VALUE="hello world"
INVALID LINE
`)

    expect(parsed.OPENAI_API_KEY).toBe('plain')
    expect(parsed.OPENAI_BASE_URL).toBe('https://example.test/v1')
    expect(parsed.QUOTED_VALUE).toBe('hello world')
    expect(parsed.INVALID).toBeUndefined()
  })

  test('creates a template env.config when no config exists', () => {
    const env = getEnvConfigEnvironment()
    const filePath = getPreferredEnvConfigFilePath()
    const egressPath = getPreferredRefereeEgressConfigFilePath()

    expect(env).toEqual({})
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(egressPath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'RedScope AI environment configuration',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'REDSCOPE_MODEL_PROVIDER=deepseek',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'REDSCOPE_MODEL_PROVIDER=kimi',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'REDSCOPE_MODEL_PROVIDER=minimax',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'REDSCOPE_TOOLS_PROFILE_REGISTRY=tools/redscope-run-profiles.json',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'REDSCOPE_TOOLS_EXTERNAL_POC_PROVIDERS=github,bing,google,baidu',
    )
  })

  test('migrates a legacy config-directory .env into env.config once', () => {
    const legacyDir = process.env.CLAUDE_CONFIG_DIR!
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, '.env'), 'LEGACY_KEY=from-dot-env\n')

    const env = getEnvConfigEnvironment()
    const filePath = getPreferredEnvConfigFilePath()

    expect(env.LEGACY_KEY).toBe('from-dot-env')
    expect(readFileSync(filePath, 'utf-8')).toContain(
      'Migrated from legacy .env',
    )
    expect(readFileSync(filePath, 'utf-8')).toContain('LEGACY_KEY=from-dot-env')
  })

  test('updates env.config values without leaving stale duplicate keys', () => {
    const filePath = getPreferredEnvConfigFilePath()
    updateEnvConfigValues({ DUPLICATE_KEY: 'old' })
    updateEnvConfigValues({ DUPLICATE_KEY: 'new' })

    const content = readFileSync(filePath, 'utf-8')
    const matches = content.match(/^DUPLICATE_KEY=/gm) ?? []

    expect(matches).toHaveLength(1)
    expect(getEnvConfigEnvironment().DUPLICATE_KEY).toBe('new')
    expect(process.env.DUPLICATE_KEY).toBe('new')
  })

  test('expands DeepSeek provider preset to OpenAI-compatible runtime env', () => {
    const expanded = expandEnvConfigEnvironment({
      REDSCOPE_MODEL_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'secret',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    })

    expect(expanded.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(expanded.CLAUDE_CODE_USE_GEMINI).toBe('0')
    expect(expanded.CLAUDE_CODE_USE_GROK).toBe('0')
    expect(expanded.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(expanded.OPENAI_API_KEY).toBe('secret')
    expect(expanded.OPENAI_MODEL).toBe('deepseek-reasoner')
    expect(expanded.OPENAI_DEFAULT_SONNET_MODEL).toBe('deepseek-reasoner')
  })

  test('expands DeepSeek Anthropic preset from REDSCOPE aliases and normalizes root URL', () => {
    const expanded = expandEnvConfigEnvironment({
      REDSCOPE_MODEL_PROVIDER: 'deepseek-anthropic',
      REDSCOPE_BASE_URL: 'https://api.deepseek.com',
      REDSCOPE_AUTH_TOKEN: 'secret',
      REDSCOPE_MODEL: 'deepseek-v4-pro[1m]',
      REDSCOPE_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      REDSCOPE_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      REDSCOPE_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
    })

    expect(expanded.CLAUDE_CODE_USE_OPENAI).toBe('0')
    expect(expanded.CLAUDE_CODE_USE_GEMINI).toBe('0')
    expect(expanded.CLAUDE_CODE_USE_GROK).toBe('0')
    expect(expanded.ANTHROPIC_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(expanded.ANTHROPIC_AUTH_TOKEN).toBe('secret')
    expect(expanded.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(expanded.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(expanded.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(expanded.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
  })

  test('applies generic REDSCOPE model env from the current process', () => {
    process.env.REDSCOPE_BASE_URL = 'https://api.deepseek.com'
    process.env.REDSCOPE_AUTH_TOKEN = 'sk-test'
    process.env.REDSCOPE_MODEL = 'deepseek-v4-pro[1m]'
    process.env.REDSCOPE_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro[1m]'
    process.env.REDSCOPE_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
    process.env.REDSCOPE_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.REDSCOPE_SUBAGENT_MODEL = 'deepseek-v4-flash'
    process.env.REDSCOPE_EFFORT_LEVEL = 'max'

    applyEnvConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBe('0')
    expect(process.env.CLAUDE_CODE_USE_GROK).toBe('0')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com')
    expect(process.env.OPENAI_API_KEY).toBe('sk-test')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(process.env.OPENAI_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(process.env.OPENAI_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(process.env.OPENAI_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash')
    expect(process.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })

  test('current process env overrides env.config defaults', () => {
    const filePath = getPreferredEnvConfigFilePath()
    mkdirSync(process.env.REDSCOPE_CONFIG_DIR!, { recursive: true })
    writeFileSync(
      filePath,
      [
        'REDSCOPE_BASE_URL=https://config.example/v1',
        'REDSCOPE_AUTH_TOKEN=config-token',
        'REDSCOPE_MODEL=config-model',
        'OPENAI_MODEL=config-openai-model',
        '',
      ].join('\n'),
    )
    process.env.REDSCOPE_BASE_URL = 'https://api.deepseek.com'
    process.env.REDSCOPE_AUTH_TOKEN = 'shell-token'
    process.env.REDSCOPE_MODEL = 'deepseek-v4-pro[1m]'

    applyEnvConfigEnvironmentVariables()

    expect(process.env.REDSCOPE_BASE_URL).toBe('https://api.deepseek.com')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com')
    expect(process.env.OPENAI_API_KEY).toBe('shell-token')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-pro[1m]')
  })

  test('migrates legacy settings provider env into env.config once', () => {
    const migrated = migrateLegacyRuntimeModelConfigValues({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      SAFE_NON_PROVIDER_VALUE: 'ignored',
    })

    const filePath = getPreferredEnvConfigFilePath()
    const content = readFileSync(filePath, 'utf-8')

    expect(migrated).toBe(true)
    expect(content).toContain(
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
    )
    expect(content).toContain('ANTHROPIC_AUTH_TOKEN=secret')
    expect(content).toContain(
      'ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]',
    )
    expect(content).not.toContain('SAFE_NON_PROVIDER_VALUE')

    const secondMigration = migrateLegacyRuntimeModelConfigValues({
      OPENAI_API_KEY: 'new-secret',
    })
    expect(secondMigration).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).not.toContain('new-secret')
  })
})
