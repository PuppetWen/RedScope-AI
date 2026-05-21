import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
  GLOBAL_REDSCOPE_FOLDER_PERMISSION_PATTERN,
  REDSCOPE_FOLDER_PERMISSION_PATTERN,
} from '@redscope-ai/builtin-tools/tools/FileEditTool/constants.js'
import { env } from '../../../utils/env.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  type CompletionType,
  logUnaryEvent,
} from '../../../utils/unaryLogging.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type {
  FileOperationType,
  PermissionOption,
} from './permissionOptions.js'

function logPermissionEvent(
  event: 'accept' | 'reject',
  completionType: CompletionType,
  languageName: string | Promise<string>,
  messageId: string,
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type: completionType,
    event,
    metadata: {
      language_name: languageName,
      message_id: messageId,
      platform: env.platform,
      hasFeedback: hasFeedback ?? false,
    },
  })
}

export type PermissionHandlerParams = {
  messageId: string
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  onDone: () => void
  onReject: () => void
  completionType: CompletionType
  languageName: string | Promise<string>
  operationType: FileOperationType
}

export type PermissionHandlerOptions = {
  hasFeedback?: boolean
  feedback?: string
  enteredFeedbackMode?: boolean
  scope?:
    | 'claude-folder'
    | 'global-claude-folder'
    | 'redscope-folder'
    | 'global-redscope-folder'
}

function handleAcceptOnce(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const { messageId, toolUseConfirm, onDone, completionType, languageName } =
    params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // Log accept submission with feedback context
  logEvent('tengu_accept_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  toolUseConfirm.onAllow(toolUseConfirm.input, [], options?.feedback)
}

function handleAcceptSession(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    path,
    toolUseConfirm,
    toolPermissionContext,
    onDone,
    completionType,
    languageName,
    operationType,
  } = params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // For config-folder scope, grant session-level access to RedScope/legacy
  // config files.
  if (
    options?.scope === 'claude-folder' ||
    options?.scope === 'global-claude-folder' ||
    options?.scope === 'redscope-folder' ||
    options?.scope === 'global-redscope-folder'
  ) {
    const patternByScope = {
      'claude-folder': CLAUDE_FOLDER_PERMISSION_PATTERN,
      'global-claude-folder': GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
      'redscope-folder': REDSCOPE_FOLDER_PERMISSION_PATTERN,
      'global-redscope-folder': GLOBAL_REDSCOPE_FOLDER_PERMISSION_PATTERN,
    } as const
    const pattern = patternByScope[options.scope]
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [
          {
            toolName: FILE_EDIT_TOOL_NAME,
            ruleContent: pattern,
          },
        ],
        behavior: 'allow',
        destination: 'session',
      },
    ]
    onDone()
    toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
    return
  }

  // Generate permission updates if path is provided
  const suggestions = path
    ? generateSuggestions(path, operationType, toolPermissionContext)
    : []

  onDone()
  // Pass permission updates directly to onAllow
  toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
}

function handleReject(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    toolUseConfirm,
    onDone,
    onReject,
    completionType,
    languageName,
  } = params

  logPermissionEvent(
    'reject',
    completionType,
    languageName,
    messageId,
    options?.hasFeedback,
  )

  // Log reject submission with feedback context
  logEvent('tengu_reject_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  onReject()
  toolUseConfirm.onReject(options?.feedback)
}

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = {
  'accept-once': handleAcceptOnce,
  'accept-session': handleAcceptSession,
  reject: handleReject,
}
