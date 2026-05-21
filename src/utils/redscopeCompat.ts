import memoize from 'lodash-es/memoize.js'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getManagedFilePath } from './settings/managedPath.js'

export const REDSCOPE_CONFIG_DIR = '.redscope'
export const CLAUDE_CONFIG_DIR = '.claude'
export const REDSCOPE_MEMORY_FILE = 'REDSCOPE.md'
export const CLAUDE_MEMORY_FILE = 'CLAUDE.md'
export const REDSCOPE_LOCAL_MEMORY_FILE = 'REDSCOPE.local.md'
export const CLAUDE_LOCAL_MEMORY_FILE = 'CLAUDE.local.md'

export const getRedScopeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.REDSCOPE_CONFIG_DIR ?? join(homedir(), REDSCOPE_CONFIG_DIR)
    ).normalize('NFC')
  },
  () => process.env.REDSCOPE_CONFIG_DIR,
)

export const getLegacyClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), CLAUDE_CONFIG_DIR)
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = path.normalize('NFC')
    const key =
      process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

export function getUserConfigHomeDirs(): string[] {
  if (process.env.REDSCOPE_CONFIG_DIR) {
    return uniquePaths([
      getRedScopeConfigHomeDir(),
      getLegacyClaudeConfigHomeDir(),
    ])
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return uniquePaths([getLegacyClaudeConfigHomeDir()])
  }
  return uniquePaths([
    getRedScopeConfigHomeDir(),
    getLegacyClaudeConfigHomeDir(),
  ])
}

export function getPreferredUserConfigHomeDir(): string {
  if (process.env.REDSCOPE_CONFIG_DIR) {
    return getRedScopeConfigHomeDir()
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return getLegacyClaudeConfigHomeDir()
  }
  return getRedScopeConfigHomeDir()
}

export function getUserConfigSubdirs(subdir: string): string[] {
  return uniquePaths(getUserConfigHomeDirs().map(dir => join(dir, subdir)))
}

export function getPreferredUserConfigSubdir(subdir: string): string {
  return join(getPreferredUserConfigHomeDir(), subdir)
}

export function getPreferredUserConfigChildPath(
  subdir: string,
  ...segments: string[]
): string {
  return join(getPreferredUserConfigSubdir(subdir), ...segments)
}

export function getUserConfigChildPaths(
  subdir: string,
  ...segments: string[]
): string[] {
  return uniquePaths(
    getUserConfigSubdirs(subdir).map(dir => join(dir, ...segments)),
  )
}

export function getCompatibleUserConfigSubdir(subdir: string): string {
  for (const dir of getUserConfigSubdirs(subdir)) {
    if (existsSync(dir)) return dir
  }
  return getPreferredUserConfigSubdir(subdir)
}

export function getCompatibleUserConfigChildPath(
  subdir: string,
  ...segments: string[]
): string {
  for (const dir of getUserConfigSubdirs(subdir)) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return join(getPreferredUserConfigSubdir(subdir), ...segments)
}

export function getUserConfigFiles(filename: string): string[] {
  return uniquePaths(getUserConfigHomeDirs().map(dir => join(dir, filename)))
}

export function getPreferredUserConfigFile(filename: string): string {
  return join(getPreferredUserConfigHomeDir(), filename)
}

export function getCompatibleUserConfigFile(filename: string): string {
  for (const file of getUserConfigFiles(filename)) {
    if (existsSync(file)) return file
  }
  return getPreferredUserConfigFile(filename)
}

export function getManagedConfigSubdirs(subdir: string): string[] {
  const root = getManagedFilePath()
  return uniquePaths([
    join(root, REDSCOPE_CONFIG_DIR, subdir),
    join(root, CLAUDE_CONFIG_DIR, subdir),
  ])
}

export function getProjectConfigSubdirs(
  root: string,
  subdir: string,
): string[] {
  return uniquePaths([
    join(root, REDSCOPE_CONFIG_DIR, subdir),
    join(root, CLAUDE_CONFIG_DIR, subdir),
  ])
}

export function getProjectConfigFiles(
  root: string,
  filename: string,
): string[] {
  return uniquePaths([
    join(root, REDSCOPE_CONFIG_DIR, filename),
    join(root, CLAUDE_CONFIG_DIR, filename),
  ])
}

export function getPreferredProjectConfigDir(root: string): string {
  return join(root, REDSCOPE_CONFIG_DIR)
}

export function getCompatibleProjectConfigSubdir(
  root: string,
  subdir: string,
): string {
  for (const dir of getProjectConfigSubdirs(root, subdir)) {
    if (existsSync(dir)) return dir
  }
  return join(getPreferredProjectConfigDir(root), subdir)
}

export function getProjectConfigChildPaths(
  root: string,
  subdir: string,
  ...segments: string[]
): string[] {
  return uniquePaths(
    getProjectConfigSubdirs(root, subdir).map(dir => join(dir, ...segments)),
  )
}

export function getPreferredProjectConfigChildPath(
  root: string,
  subdir: string,
  ...segments: string[]
): string {
  return join(getPreferredProjectConfigDir(root), subdir, ...segments)
}

export function getCompatibleProjectConfigChildPath(
  root: string,
  subdir: string,
  ...segments: string[]
): string {
  for (const dir of getProjectConfigSubdirs(root, subdir)) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return join(getPreferredProjectConfigDir(root), subdir, ...segments)
}

export function getProjectMemoryFiles(root: string): string[] {
  return [
    join(root, CLAUDE_MEMORY_FILE),
    join(root, CLAUDE_CONFIG_DIR, CLAUDE_MEMORY_FILE),
    join(root, REDSCOPE_MEMORY_FILE),
    join(root, REDSCOPE_CONFIG_DIR, REDSCOPE_MEMORY_FILE),
  ]
}

export function getLocalMemoryFiles(root: string): string[] {
  return [
    join(root, CLAUDE_LOCAL_MEMORY_FILE),
    join(root, REDSCOPE_LOCAL_MEMORY_FILE),
  ]
}

export function getProjectRulesDirs(root: string): string[] {
  return [
    join(root, CLAUDE_CONFIG_DIR, 'rules'),
    join(root, REDSCOPE_CONFIG_DIR, 'rules'),
  ]
}

export function getUserMemoryFiles(): string[] {
  return uniquePaths([
    join(getLegacyClaudeConfigHomeDir(), CLAUDE_MEMORY_FILE),
    join(getRedScopeConfigHomeDir(), REDSCOPE_MEMORY_FILE),
  ])
}

export function getUserRulesDirs(): string[] {
  return uniquePaths([
    join(getLegacyClaudeConfigHomeDir(), 'rules'),
    join(getRedScopeConfigHomeDir(), 'rules'),
  ])
}

export function getManagedMemoryFiles(): string[] {
  const root = getManagedFilePath()
  return [join(root, CLAUDE_MEMORY_FILE), join(root, REDSCOPE_MEMORY_FILE)]
}

export function getManagedRulesDirs(): string[] {
  const root = getManagedFilePath()
  return [
    join(root, CLAUDE_CONFIG_DIR, 'rules'),
    join(root, REDSCOPE_CONFIG_DIR, 'rules'),
  ]
}
