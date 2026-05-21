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
  ensureUserRefereeEgressConfigFile,
  getPreferredRefereeEgressConfigFilePath,
  REFEREE_EGRESS_STATE_FILE,
} from '../authorizedEgressConfig'

describe('authorizedEgressConfig', () => {
  let tempDir = ''
  let previousRedScopeConfigDir: string | undefined
  let previousClaudeConfigDir: string | undefined
  let previousTemplatePath: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'redscope-egress-config-'))
    previousRedScopeConfigDir = process.env.REDSCOPE_CONFIG_DIR
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousTemplatePath = process.env.REDSCOPE_REFEREE_EGRESS_TEMPLATE_PATH
    process.env.REDSCOPE_CONFIG_DIR = join(tempDir, 'redscope')
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude')
    delete process.env.REDSCOPE_REFEREE_EGRESS_TEMPLATE_PATH
  })

  afterEach(() => {
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
    if (previousTemplatePath === undefined) {
      delete process.env.REDSCOPE_REFEREE_EGRESS_TEMPLATE_PATH
    } else {
      process.env.REDSCOPE_REFEREE_EGRESS_TEMPLATE_PATH = previousTemplatePath
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates the referee egress config in the preferred user config dir', () => {
    const result = ensureUserRefereeEgressConfigFile()
    const filePath = getPreferredRefereeEgressConfigFilePath()

    expect(result.error).toBeNull()
    expect(result.created).toBe(true)
    expect(result.filePath).toBe(filePath)
    expect(existsSync(filePath)).toBe(true)

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      policy: { statePath: string; defaultPoolId: string }
      egressPools: Array<{ nodes: unknown[] }>
    }
    expect(parsed.policy.defaultPoolId).toBe(
      'referee-provided-traffic-simulation',
    )
    expect(parsed.policy.statePath).toBe(
      join(process.env.REDSCOPE_CONFIG_DIR!, REFEREE_EGRESS_STATE_FILE),
    )
    expect(parsed.egressPools[0]?.nodes.length).toBeGreaterThan(0)
  })

  test('does not overwrite an existing user-edited referee egress config', () => {
    const filePath = getPreferredRefereeEgressConfigFilePath()
    mkdirSync(process.env.REDSCOPE_CONFIG_DIR!, { recursive: true })
    writeFileSync(filePath, '{"custom":true}\n')

    const result = ensureUserRefereeEgressConfigFile()

    expect(result.error).toBeNull()
    expect(result.created).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('{"custom":true}\n')
  })
})
