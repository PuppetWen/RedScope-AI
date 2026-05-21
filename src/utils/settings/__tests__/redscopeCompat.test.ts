import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'path'
import {
  cleanupTempDir,
  createTempDir,
  writeTempFile,
} from '../../../../tests/mocks/file-system'

let tempDir = ''
const repoRoot = resolve(import.meta.dir, '../../../..')

async function runSettingsProbe<T>(probe: string): Promise<T> {
  const proc = Bun.spawn(['bun', '-e', probe], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEST_TEMP_DIR: tempDir,
      CLAUDE_CONFIG_DIR: join(tempDir, 'legacy-home'),
      REDSCOPE_CONFIG_DIR: join(tempDir, 'redscope-home'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`Probe failed (${exitCode}):\n${stderr}\n${stdout}`)
  }

  const jsonLine = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)

  if (!jsonLine) {
    throw new Error(`Probe did not print JSON.\nstderr:\n${stderr}`)
  }

  return JSON.parse(jsonLine) as T
}

function settingsProbe(expression: string): string {
  return `
    import { join } from 'path';
    import {
      getGlobalClaudeFile,
      getGlobalConfigFiles,
    } from './src/utils/env.js';
    import {
      getStatsCachePath,
      getStatsCachePaths,
    } from './src/utils/statsCache.js';
    import {
      resetStateForTests,
      setOriginalCwd,
      setProjectRoot,
    } from './src/bootstrap/state.js';
    import { getClaudeConfigHomeDir } from './src/utils/envUtils.js';
    import {
      getInitialSettings,
      getLegacyClaudeSettingsCompatibilityDecision,
      getRelativeSettingsFilePathForSource,
      getSettingsFilePathForSource,
      getSettingsFilePathsForSource,
      getSettingsForSource,
      hasLegacyClaudeSettingsCompatibilityDecision,
      isLegacyClaudeSettingsCompatibilityEnabled,
      rawSettingsContainsKey,
      setLegacyClaudeSettingsCompatibility,
      shouldPromptForLegacyClaudeSettingsCompatibility,
    } from './src/utils/settings/settings.js';
    import { resetSettingsCache } from './src/utils/settings/settingsCache.js';
    import {
      getLegacyClaudeConfigHomeDir,
      getRedScopeConfigHomeDir,
    } from './src/utils/redscopeCompat.js';

    const tempDir = process.env.TEST_TEMP_DIR;
    if (!tempDir) throw new Error('TEST_TEMP_DIR is required');

    function clearConfigCaches() {
      getGlobalClaudeFile.cache?.clear?.();
      getClaudeConfigHomeDir.cache?.clear?.();
      getRedScopeConfigHomeDir.cache?.clear?.();
      getLegacyClaudeConfigHomeDir.cache?.clear?.();
      resetSettingsCache();
    }

    resetStateForTests();
    setOriginalCwd(tempDir);
    setProjectRoot(tempDir);
    clearConfigCaches();

    const result = ${expression};
    console.log(JSON.stringify(result));
  `
}

beforeEach(async () => {
  tempDir = await createTempDir('redscope-settings-')
})

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir)
  }
})

describe('RedScope settings compatibility', () => {
  test('returns RedScope-only settings paths before legacy opt-in', async () => {
    const paths = await runSettingsProbe<{
      user: string[]
      project: string[]
      local: string[]
      compat: boolean
    }>(
      settingsProbe(`({
        user: getSettingsFilePathsForSource('userSettings'),
        project: getSettingsFilePathsForSource('projectSettings'),
        local: getSettingsFilePathsForSource('localSettings'),
        compat: isLegacyClaudeSettingsCompatibilityEnabled(),
      })`),
    )

    expect(paths.user).toEqual([
      join(tempDir, 'redscope-home', 'settings.json'),
    ])
    expect(paths.project).toEqual([join(tempDir, '.redscope', 'settings.json')])
    expect(paths.local).toEqual([
      join(tempDir, '.redscope', 'settings.local.json'),
    ])
    expect(paths.compat).toBe(false)
  })

  test('includes legacy settings paths only after RedScope opt-in', async () => {
    await writeTempFile(
      tempDir,
      '.redscope/settings.local.json',
      JSON.stringify({ legacyClaudeConfigCompatibility: true }),
    )

    const paths = await runSettingsProbe<{
      user: string[]
      project: string[]
      local: string[]
      compat: boolean
    }>(
      settingsProbe(`({
        user: getSettingsFilePathsForSource('userSettings'),
        project: getSettingsFilePathsForSource('projectSettings'),
        local: getSettingsFilePathsForSource('localSettings'),
        compat: isLegacyClaudeSettingsCompatibilityEnabled(),
      })`),
    )

    expect(paths.user).toEqual([
      join(tempDir, 'legacy-home', 'settings.json'),
      join(tempDir, 'redscope-home', 'settings.json'),
    ])
    expect(paths.project).toEqual([
      join(tempDir, '.claude', 'settings.json'),
      join(tempDir, '.redscope', 'settings.json'),
    ])
    expect(paths.local).toEqual([
      join(tempDir, '.claude', 'settings.local.json'),
      join(tempDir, '.redscope', 'settings.local.json'),
    ])
    expect(paths.compat).toBe(true)
  })

  test('sets legacy compatibility through the RedScope settings helper', async () => {
    const result = await runSettingsProbe<{
      error: string | null
      filePath: string | undefined
      compat: boolean
      value: boolean | undefined
    }>(
      settingsProbe(`(() => {
        const write = setLegacyClaudeSettingsCompatibility(true, 'user');
        return {
          error: write.error?.message ?? null,
          filePath: write.filePath,
          compat: isLegacyClaudeSettingsCompatibilityEnabled(),
          value: getSettingsForSource('userSettings')?.legacyClaudeConfigCompatibility,
        };
      })()`),
    )

    expect(result.error).toBe(null)
    expect(result.filePath).toBe(
      join(tempDir, 'redscope-home', 'settings.json'),
    )
    expect(result.compat).toBe(true)
    expect(result.value).toBe(true)
  })

  test('tracks an explicit false compatibility decision for first-launch prompting', async () => {
    const result = await runSettingsProbe<{
      beforeDecision: boolean | undefined
      beforeHasDecision: boolean
      beforePrompt: boolean
      error: string | null
      afterDecision: boolean | undefined
      afterHasDecision: boolean
      afterPrompt: boolean
      compat: boolean
    }>(
      settingsProbe(`(() => {
        const beforeDecision = getLegacyClaudeSettingsCompatibilityDecision();
        const beforeHasDecision = hasLegacyClaudeSettingsCompatibilityDecision();
        const beforePrompt = shouldPromptForLegacyClaudeSettingsCompatibility();
        const write = setLegacyClaudeSettingsCompatibility(false, 'user');
        return {
          beforeDecision,
          beforeHasDecision,
          beforePrompt,
          error: write.error?.message ?? null,
          afterDecision: getLegacyClaudeSettingsCompatibilityDecision(),
          afterHasDecision: hasLegacyClaudeSettingsCompatibilityDecision(),
          afterPrompt: shouldPromptForLegacyClaudeSettingsCompatibility(),
          compat: isLegacyClaudeSettingsCompatibilityEnabled(),
        };
      })()`),
    )

    expect(result.beforeDecision).toBeUndefined()
    expect(result.beforeHasDecision).toBe(false)
    expect(result.beforePrompt).toBe(true)
    expect(result.error).toBe(null)
    expect(result.afterDecision).toBe(false)
    expect(result.afterHasDecision).toBe(true)
    expect(result.afterPrompt).toBe(false)
    expect(result.compat).toBe(false)
  })

  test('skips first-launch prompt when compatibility is forced by env', async () => {
    const result = await runSettingsProbe<{
      prompt: boolean
      compat: boolean
    }>(
      settingsProbe(`(() => {
        process.env.REDSCOPE_LEGACY_CLAUDE_CONFIG_COMPATIBILITY = '1';
        return {
          prompt: shouldPromptForLegacyClaudeSettingsCompatibility(),
          compat: isLegacyClaudeSettingsCompatibilityEnabled(),
        };
      })()`),
    )

    expect(result.prompt).toBe(false)
    expect(result.compat).toBe(true)
  })

  test('uses RedScope paths for new settings writes', async () => {
    const paths = await runSettingsProbe<{
      user: string | undefined
      project: string | undefined
      local: string | undefined
      projectRelative: string
      localRelative: string
    }>(
      settingsProbe(`({
        user: getSettingsFilePathForSource('userSettings'),
        project: getSettingsFilePathForSource('projectSettings'),
        local: getSettingsFilePathForSource('localSettings'),
        projectRelative: getRelativeSettingsFilePathForSource('projectSettings'),
        localRelative: getRelativeSettingsFilePathForSource('localSettings'),
      })`),
    )

    expect(paths.user).toBe(join(tempDir, 'redscope-home', 'settings.json'))
    expect(paths.project).toBe(join(tempDir, '.redscope', 'settings.json'))
    expect(paths.local).toBe(join(tempDir, '.redscope', 'settings.local.json'))
    expect(paths.projectRelative).toBe(join('.redscope', 'settings.json'))
    expect(paths.localRelative).toBe(join('.redscope', 'settings.local.json'))
  })

  test('ignores project .claude settings before legacy opt-in', async () => {
    await writeTempFile(
      tempDir,
      '.claude/settings.json',
      JSON.stringify({
        env: { LEGACY_ONLY: '1', SHARED: 'legacy' },
      }),
    )
    await writeTempFile(
      tempDir,
      '.redscope/settings.json',
      JSON.stringify({
        env: { REDSCOPE_ONLY: '1', SHARED: 'redscope' },
      }),
    )

    const env = await runSettingsProbe<Record<string, string>>(
      settingsProbe("getSettingsForSource('projectSettings')?.env"),
    )

    expect(env).toEqual({
      REDSCOPE_ONLY: '1',
      SHARED: 'redscope',
    })
  })

  test('merges project .claude and .redscope settings after opt-in with RedScope taking precedence', async () => {
    await writeTempFile(
      tempDir,
      '.claude/settings.json',
      JSON.stringify({
        env: { LEGACY_ONLY: '1', SHARED: 'legacy' },
      }),
    )
    await writeTempFile(
      tempDir,
      '.redscope/settings.json',
      JSON.stringify({
        legacyClaudeConfigCompatibility: true,
        env: { REDSCOPE_ONLY: '1', SHARED: 'redscope' },
      }),
    )

    const env = await runSettingsProbe<Record<string, string>>(
      settingsProbe("getSettingsForSource('projectSettings')?.env"),
    )

    expect(env).toEqual({
      LEGACY_ONLY: '1',
      REDSCOPE_ONLY: '1',
      SHARED: 'redscope',
    })
  })

  test('merges user config homes with RedScope taking precedence', async () => {
    await writeTempFile(
      tempDir,
      'legacy-home/settings.json',
      JSON.stringify({
        env: { LEGACY_HOME: '1', SHARED_HOME: 'legacy' },
      }),
    )
    await writeTempFile(
      tempDir,
      'redscope-home/settings.json',
      JSON.stringify({
        legacyClaudeConfigCompatibility: true,
        env: { REDSCOPE_HOME: '1', SHARED_HOME: 'redscope' },
      }),
    )

    const env = await runSettingsProbe<Record<string, string>>(
      settingsProbe("getSettingsForSource('userSettings')?.env"),
    )

    expect(env).toEqual({
      LEGACY_HOME: '1',
      REDSCOPE_HOME: '1',
      SHARED_HOME: 'redscope',
    })
  })

  test('loads RedScope local settings in the effective settings cascade', async () => {
    await writeTempFile(
      tempDir,
      '.redscope/settings.local.json',
      JSON.stringify({ cleanupPeriodDays: 7 }),
    )

    const result = await runSettingsProbe<{
      cleanupPeriodDays: number | undefined
      containsKey: boolean
    }>(
      settingsProbe(`({
        cleanupPeriodDays: getInitialSettings().cleanupPeriodDays,
        containsKey: rawSettingsContainsKey('cleanupPeriodDays'),
      })`),
    )

    expect(result.cleanupPeriodDays).toBe(7)
    expect(result.containsKey).toBe(true)
  })

  test('prefers RedScope root global config before legacy config-dir fallback', async () => {
    await writeTempFile(tempDir, 'redscope-home/.redscope.json', '{}')
    await writeTempFile(tempDir, 'legacy-home/.config.json', '{}')

    const result = await runSettingsProbe<{
      selected: string
      candidates: string[]
    }>(
      settingsProbe(`({
        selected: getGlobalClaudeFile(),
        candidates: getGlobalConfigFiles(),
      })`),
    )

    expect(result.selected).toBe(
      join(tempDir, 'redscope-home', '.redscope.json'),
    )
    expect(result.candidates).toEqual([
      join(tempDir, 'redscope-home', '.redscope.json'),
      join(tempDir, 'legacy-home', '.claude.json'),
    ])
  })

  test('uses RedScope-first stats cache paths with legacy fallback candidates', async () => {
    const result = await runSettingsProbe<{
      selected: string
      candidates: string[]
    }>(
      settingsProbe(`({
        selected: getStatsCachePath(),
        candidates: getStatsCachePaths(),
      })`),
    )

    expect(result.selected).toBe(
      join(tempDir, 'redscope-home', 'stats-cache.json'),
    )
    expect(result.candidates).toEqual([
      join(tempDir, 'redscope-home', 'stats-cache.json'),
      join(tempDir, 'legacy-home', 'stats-cache.json'),
    ])
  })
})
