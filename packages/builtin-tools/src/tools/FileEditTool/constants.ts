// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claude/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// Permission pattern for granting session-level access to the global ~/.claude/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

// Permission pattern for granting session-level access to the project's .redscope/ folder
export const REDSCOPE_FOLDER_PERMISSION_PATTERN = '/.redscope/**'

// Permission pattern for granting session-level access to the global ~/.redscope/ folder
export const GLOBAL_REDSCOPE_FOLDER_PERMISSION_PATTERN = '~/.redscope/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
