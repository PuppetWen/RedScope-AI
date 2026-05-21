import { basename, join, sep } from 'path';
import React, { type ReactNode } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Text } from '@anthropic/ink';
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { expandPath, getDirectoryForPath } from '../../../utils/path.js';
import { normalizeCaseForComparison, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js';
import {
  CLAUDE_CONFIG_DIR,
  REDSCOPE_CONFIG_DIR,
  getLegacyClaudeConfigHomeDir,
  getRedScopeConfigHomeDir,
} from '../../../utils/redscopeCompat.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';

function isWithinConfigDirectory(filePath: string, configDir: string): boolean {
  const absolutePath = expandPath(filePath);
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedConfigDir = normalizeCaseForComparison(expandPath(configDir));

  return (
    normalizedAbsolutePath.startsWith(normalizedConfigDir + sep.toLowerCase()) ||
    normalizedAbsolutePath.startsWith(normalizedConfigDir + '/')
  );
}

/**
 * Check if a path is within the project's .claude/ folder.
 * This is used to determine whether to show the special ".claude folder" permission option.
 */
export function isInClaudeFolder(filePath: string): boolean {
  return isWithinConfigDirectory(filePath, join(getOriginalCwd(), CLAUDE_CONFIG_DIR));
}

export function isInRedScopeFolder(filePath: string): boolean {
  return isWithinConfigDirectory(filePath, join(getOriginalCwd(), REDSCOPE_CONFIG_DIR));
}

/**
 * Check if a path is within the global ~/.claude/ folder.
 * This is used to determine whether to show the special ".claude folder" permission option
 * for files in the user's home directory.
 */
export function isInGlobalClaudeFolder(filePath: string): boolean {
  return isWithinConfigDirectory(filePath, getLegacyClaudeConfigHomeDir());
}

export function isInGlobalRedScopeFolder(filePath: string): boolean {
  return isWithinConfigDirectory(filePath, getRedScopeConfigHomeDir());
}

export type PermissionOption =
  | { type: 'accept-once' }
  | {
      type: 'accept-session';
      scope?: 'claude-folder' | 'global-claude-folder' | 'redscope-folder' | 'global-redscope-folder';
    }
  | { type: 'reject' };

export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption;
};

export type FileOperationType = 'read' | 'write' | 'create';

export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
}: {
  filePath: string;
  toolPermissionContext: ToolPermissionContext;
  operationType?: FileOperationType;
  onRejectFeedbackChange?: (value: string) => void;
  onAcceptFeedbackChange?: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = [];
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell RedScope AI what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'accept-once' },
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes',
      option: { type: 'accept-once' },
    });
  }

  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext);

  // Check if this is a RedScope/legacy config folder path (project or global)
  const inClaudeFolder = isInClaudeFolder(filePath);
  const inGlobalClaudeFolder = isInGlobalClaudeFolder(filePath);
  const inRedScopeFolder = isInRedScopeFolder(filePath);
  const inGlobalRedScopeFolder = isInGlobalRedScopeFolder(filePath);
  const configScope = inGlobalRedScopeFolder
    ? 'global-redscope-folder'
    : inRedScopeFolder
      ? 'redscope-folder'
      : inGlobalClaudeFolder
        ? 'global-claude-folder'
        : inClaudeFolder
          ? 'claude-folder'
          : undefined;

  // Option 2: For config folders, show special option instead of generic session option
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if (configScope && operationType !== 'read') {
    options.push({
      label: 'Yes, and allow RedScope AI to edit its own settings for this session',
      value: 'yes-config-folder',
      option: {
        type: 'accept-session',
        scope: configScope,
      },
    });
  } else {
    // Option 2: Allow all changes/reads during session
    let sessionLabel: ReactNode;

    if (inAllowedPath) {
      // Inside working directory
      if (operationType === 'read') {
        sessionLabel = 'Yes, during this session';
      } else {
        sessionLabel = (
          <Text>
            Yes, allow all edits during this session <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    } else {
      // Outside working directory - include directory name
      const dirPath = getDirectoryForPath(filePath);
      const dirName = basename(dirPath) || 'this directory';

      if (operationType === 'read') {
        sessionLabel = (
          <Text>
            Yes, allow reading from <Text bold>{dirName}/</Text> during this session
          </Text>
        );
      } else {
        sessionLabel = (
          <Text>
            Yes, allow all edits in <Text bold>{dirName}/</Text> during this session{' '}
            <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    }

    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: { type: 'accept-session' },
    });
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell RedScope AI what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'reject' },
    });
  } else {
    // Not in input mode - simple option
    options.push({
      label: 'No',
      value: 'no',
      option: { type: 'reject' },
    });
  }

  return options;
}
