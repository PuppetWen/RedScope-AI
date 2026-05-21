import { describe, expect, test } from 'bun:test'
import {
  findPackagedSecretFindings,
  isForbiddenPackagePath,
  parseNpmPackJson,
  validateRuntimeDependencies,
} from '../redscope-publish-guard.ts'

describe('redscope publish guard', () => {
  test('parses npm pack dry-run json output', () => {
    const parsed = parseNpmPackJson(
      'npm notice dry run\n[{"files":[{"path":"package.json"},{"path":"dist/cli-node.js"}]}]\n',
    )
    expect(parsed[0]?.files?.map(file => file.path)).toEqual([
      'package.json',
      'dist/cli-node.js',
    ])
  })

  test('rejects local config and output paths from package contents', () => {
    expect(isForbiddenPackagePath('.redscope/settings.json')).toBe(true)
    expect(isForbiddenPackagePath('.claude/settings.local.json')).toBe(true)
    expect(isForbiddenPackagePath('tools/outputs/run/report.md')).toBe(true)
    expect(isForbiddenPackagePath('dist/cli-node.js')).toBe(false)
  })

  test('detects real secret patterns without flagging placeholders', () => {
    const clean = findPackagedSecretFindings(
      'OPENAI_API_KEY=\nREDSCOPE_AUTH_TOKEN=<token>\nANTHROPIC_API_KEY=sk-test',
      'README.md',
      {},
    )
    expect(clean).toHaveLength(0)

    const fakeAnthropicKey = [
      'sk-ant',
      'api03-abcdefghijklmnopqrstuvwxyz1234567890',
    ].join('-')
    const findings = findPackagedSecretFindings(
      `const leaked = "${fakeAnthropicKey}"`,
      'dist/chunk.js',
      {},
    )
    expect(findings.some(finding => finding.message.includes('API key'))).toBe(
      true,
    )
  })

  test('detects sensitive values inherited from the release environment', () => {
    const findings = findPackagedSecretFindings(
      'const token = "release-token-1234567890"',
      'dist/cli.js',
      {
        REDSCOPE_AUTH_TOKEN: 'release-token-1234567890',
      },
    )
    expect(findings).toEqual([
      {
        file: 'dist/cli.js',
        message:
          'REDSCOPE_AUTH_TOKEN value from the current environment is present in packaged output',
      },
    ])
  })

  test('requires lazy runtime dependencies in npm dependencies', () => {
    expect(
      validateRuntimeDependencies({
        dependencies: { undici: '^7.25.0' },
        devDependencies: {},
      }),
    ).toHaveLength(0)

    expect(
      validateRuntimeDependencies({
        dependencies: {},
        devDependencies: { undici: '^7.25.0' },
      }),
    ).toEqual([
      {
        file: 'package.json',
        message:
          'runtime dependency "undici" must be listed in dependencies (currently only in devDependencies)',
      },
    ])
  })
})
