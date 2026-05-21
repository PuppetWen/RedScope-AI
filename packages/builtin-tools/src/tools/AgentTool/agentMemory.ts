import { existsSync } from 'fs'
import { join, normalize, sep } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import {
  buildMemoryPrompt,
  ensureMemoryDirExists,
} from 'src/memdir/memdir.js'
import { getMemoryBaseDir } from 'src/memdir/paths.js'
import { getCwd } from 'src/utils/cwd.js'
import { findCanonicalGitRoot } from 'src/utils/git.js'
import { sanitizePath } from 'src/utils/path.js'
import {
  CLAUDE_CONFIG_DIR,
  getLegacyClaudeConfigHomeDir,
  getRedScopeConfigHomeDir,
  REDSCOPE_CONFIG_DIR,
  uniquePaths,
} from 'src/utils/redscopeCompat.js'

// Persistent agent memory scope: 'user' (~/.redscope/agent-memory/), 'project' (.redscope/agent-memory/), or 'local' (.redscope/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * Sanitize an agent type name for use as a directory name.
 * Replaces colons (invalid on Windows, used in plugin-namespaced agent
 * types like "my-plugin:my-agent") with dashes.
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * Returns the local agent memory directory, which is project-specific and not checked into VCS.
 * When CLAUDE_CODE_REMOTE_MEMORY_DIR is set, persists to the mount with project namespacing.
 * Otherwise, uses <cwd>/.redscope/agent-memory-local/<agentType>/ with
 * legacy .claude fallback.
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return selectExistingOrPreferredDir([
    join(getCwd(), REDSCOPE_CONFIG_DIR, 'agent-memory-local', dirName),
    join(getCwd(), CLAUDE_CONFIG_DIR, 'agent-memory-local', dirName),
  ])
}

/**
 * Returns the agent memory directory for a given agent type and scope.
 * - 'user' scope: ~/.redscope/agent-memory/<agentType>/, with legacy ~/.claude fallback
 * - 'project' scope: <cwd>/.redscope/agent-memory/<agentType>/, with legacy .claude fallback
 * - 'local' scope: see getLocalAgentMemoryDir()
 */
function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

function selectExistingOrPreferredDir(paths: string[]): string {
  const unique = uniquePaths(paths).map(withTrailingSep)
  return unique.find(path => existsSync(path)) ?? unique[0]!
}

export function getAgentMemoryDirs(
  agentType: string,
  scope: AgentMemoryScope,
): string[] {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return uniquePaths([
        join(getCwd(), REDSCOPE_CONFIG_DIR, 'agent-memory', dirName),
        join(getCwd(), CLAUDE_CONFIG_DIR, 'agent-memory', dirName),
      ]).map(withTrailingSep)
    case 'local':
      return [getLocalAgentMemoryDir(dirName)]
    case 'user':
      if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
        return [withTrailingSep(join(getMemoryBaseDir(), 'agent-memory', dirName))]
      }
      return uniquePaths([
        join(getRedScopeConfigHomeDir(), 'agent-memory', dirName),
        join(getLegacyClaudeConfigHomeDir(), 'agent-memory', dirName),
      ]).map(withTrailingSep)
  }
}

export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return selectExistingOrPreferredDir(getAgentMemoryDirs(agentType, scope))
}

// Check if file is within an agent memory directory (any scope).
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  const userMemoryRoots = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
    ? [join(getMemoryBaseDir(), 'agent-memory') + sep]
    : [
        join(getRedScopeConfigHomeDir(), 'agent-memory') + sep,
        join(getLegacyClaudeConfigHomeDir(), 'agent-memory') + sep,
      ]
  if (userMemoryRoots.some(root => normalizedPath.startsWith(root))) {
    return true
  }

  const projectMemoryRoots = [
    join(getCwd(), REDSCOPE_CONFIG_DIR, 'agent-memory') + sep,
    join(getCwd(), CLAUDE_CONFIG_DIR, 'agent-memory') + sep,
  ]
  if (projectMemoryRoots.some(root => normalizedPath.startsWith(root))) {
    return true
  }

  // Local scope: persisted to mount when CLAUDE_CODE_REMOTE_MEMORY_DIR is set, otherwise cwd-based
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    [
      join(getCwd(), REDSCOPE_CONFIG_DIR, 'agent-memory-local') + sep,
      join(getCwd(), CLAUDE_CONFIG_DIR, 'agent-memory-local') + sep,
    ].some(root => normalizedPath.startsWith(root))
  ) {
    return true
  }

  return false
}

/**
 * Returns the agent memory file path for a given agent type and scope.
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
          ? getMemoryBaseDir()
          : getRedScopeConfigHomeDir(),
        'agent-memory',
      )}/)`
    case 'project':
      return 'Project (.redscope/agent-memory/)'
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 *
 * @param agentType The agent's type name (used as directory name)
 * @param scope 'user' for ~/.redscope/agent-memory/ or 'project' for .redscope/agent-memory/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // Fire-and-forget: this runs at agent-spawn time inside a sync
  // getSystemPrompt() callback (called from React render in AgentDetail.tsx,
  // so it cannot be async). The spawned agent won't try to Write until after
  // a full API round-trip, by which time mkdir will have completed. Even if
  // it hasn't, FileWriteTool does its own mkdir of the parent directory.
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
