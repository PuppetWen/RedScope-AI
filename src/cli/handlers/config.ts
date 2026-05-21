/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits on invalid input */

import {
  type LegacyClaudeSettingsCompatibilityScope,
  isLegacyClaudeSettingsCompatibilityEnabled,
  setLegacyClaudeSettingsCompatibility,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const LEGACY_CLAUDE_SCOPE_VALUES = [
  'user',
  'project',
  'local',
] as const satisfies readonly LegacyClaudeSettingsCompatibilityScope[]

type LegacyClaudeCompatibilityOptions = {
  json?: boolean
  scope?: string
}

export async function legacyClaudeCompatibilityStatus(
  options: Pick<LegacyClaudeCompatibilityOptions, 'json'>,
): Promise<void> {
  const enabled = isLegacyClaudeSettingsCompatibilityEnabled()
  if (options.json) {
    process.stdout.write(
      jsonStringify(
        {
          enabled,
          command: 'redscope config legacy-claude enable',
          legacyEnvAliases: [
            'REDSCOPE_LEGACY_CLAUDE_CONFIG_COMPATIBILITY',
            'REDSCOPE_ENABLE_LEGACY_CLAUDE_CONFIG',
          ],
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(
    [
      `Legacy Claude config compatibility: ${enabled ? 'enabled' : 'disabled'}`,
      'Enable: redscope config legacy-claude enable',
      'Disable: redscope config legacy-claude disable',
    ].join('\n') + '\n',
  )
}

export async function setLegacyClaudeCompatibility(
  enabled: boolean,
  options: LegacyClaudeCompatibilityOptions,
): Promise<void> {
  const scope = parseLegacyClaudeCompatibilityScope(options.scope)
  const { error, filePath } = setLegacyClaudeSettingsCompatibility(
    enabled,
    scope,
  )

  if (error) {
    process.stderr.write(
      `Failed to update RedScope settings: ${error.message}\n`,
    )
    process.exit(1)
  }

  if (options.json) {
    process.stdout.write(
      jsonStringify(
        {
          enabled,
          scope,
          filePath,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(
    [
      `Legacy Claude config compatibility ${enabled ? 'enabled' : 'disabled'}.`,
      filePath ? `Updated: ${filePath}` : undefined,
      enabled
        ? 'RedScope settings still take precedence over legacy Claude settings.'
        : 'RedScope will ignore legacy Claude settings unless enabled by env var.',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  )
}

function parseLegacyClaudeCompatibilityScope(
  scope: string | undefined,
): LegacyClaudeSettingsCompatibilityScope {
  const normalized = (scope ?? 'user').trim().toLowerCase()
  if (isLegacyClaudeCompatibilityScope(normalized)) {
    return normalized
  }

  process.stderr.write(
    'Invalid --scope value. Use one of: user, project, local.\n',
  )
  process.exit(1)
}

function isLegacyClaudeCompatibilityScope(
  value: string,
): value is LegacyClaudeSettingsCompatibilityScope {
  return LEGACY_CLAUDE_SCOPE_VALUES.includes(
    value as LegacyClaudeSettingsCompatibilityScope,
  )
}
