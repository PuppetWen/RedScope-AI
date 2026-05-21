import envPaths from 'env-paths'
import { join } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'
import { uniquePaths } from './redscopeCompat.js'

const redscopePaths = envPaths('redscope-ai')
const legacyPaths = envPaths('claude-cli')

// Local sanitizePath using djb2Hash — NOT the shared version from
// sessionStoragePortable.ts which uses Bun.hash (wyhash) when available.
// Cache directory names must remain stable across upgrades so existing cache
// data (error logs, MCP logs) is not orphaned.
const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

function getBaseLogPath(paths: ReturnType<typeof envPaths>): string {
  return join(paths.cache, getProjectDir(getFsImplementation().cwd()))
}

function getMcpLogPath(
  paths: ReturnType<typeof envPaths>,
  serverName: string,
): string {
  return join(
    paths.cache,
    getProjectDir(getFsImplementation().cwd()),
    // Sanitize server name for Windows compatibility (colons are reserved for drive letters)
    `mcp-logs-${sanitizePath(serverName)}`,
  )
}

export const CACHE_PATHS = {
  baseLogs: () => getBaseLogPath(redscopePaths),
  baseLogCandidates: () =>
    uniquePaths([getBaseLogPath(redscopePaths), getBaseLogPath(legacyPaths)]),
  errors: () => join(getBaseLogPath(redscopePaths), 'errors'),
  errorCandidates: () =>
    uniquePaths([
      join(getBaseLogPath(redscopePaths), 'errors'),
      join(getBaseLogPath(legacyPaths), 'errors'),
    ]),
  messages: () => join(getBaseLogPath(redscopePaths), 'messages'),
  messageCandidates: () =>
    uniquePaths([
      join(getBaseLogPath(redscopePaths), 'messages'),
      join(getBaseLogPath(legacyPaths), 'messages'),
    ]),
  mcpLogs: (serverName: string) => getMcpLogPath(redscopePaths, serverName),
  mcpLogCandidates: (serverName: string) =>
    uniquePaths([
      getMcpLogPath(redscopePaths, serverName),
      getMcpLogPath(legacyPaths, serverName),
    ]),
}
