import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Dialog, Text } from '@anthropic/ink';
import { setLegacyClaudeSettingsCompatibility } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';

type Props = {
  onDone(): void;
};

export function LegacyClaudeCompatibilityDialog({ onDone }: Props): React.ReactNode {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    logEvent('tengu_legacy_claude_config_dialog_shown', {});
  }, []);

  function persistDecision(enabled: boolean) {
    const { error: writeError } = setLegacyClaudeSettingsCompatibility(enabled, 'user');
    if (writeError) {
      setError(writeError.message);
      return;
    }

    logEvent('tengu_legacy_claude_config_dialog_decision', {
      enabled,
    });
    onDone();
  }

  return (
    <Dialog title="Set up RedScope configuration" color="warning" onCancel={() => persistDecision(false)}>
      <Box flexDirection="column" gap={1}>
        <Text>
          RedScope can either reuse your existing Claude settings, or stay separate and ask for RedScope API
          configuration during first-time setup.
        </Text>
        <Text dimColor>
          Reuse reads files such as <Text bold>~/.claude/settings.json</Text>, <Text bold>.claude/settings.json</Text>,
          and <Text bold>CLAUDE.md</Text>. RedScope settings still take precedence. You can change this later with{' '}
          <Text bold>redscope config legacy-claude enable</Text> or{' '}
          <Text bold>redscope config legacy-claude disable</Text>.
        </Text>
        {error && <Text color="error">Failed to save setting: {error}</Text>}
        <Select
          defaultValue="disable"
          defaultFocusValue="disable"
          options={[
            {
              label: 'Configure RedScope separately',
              value: 'disable',
            },
            {
              label: 'Reuse existing Claude config',
              value: 'enable',
            },
          ]}
          onChange={value => persistDecision(value === 'enable')}
          onCancel={() => persistDecision(false)}
        />
      </Box>
    </Dialog>
  );
}
