import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  getPreferredUserConfigFile,
  getUserConfigFiles,
  uniquePaths,
} from './redscopeCompat.js'

export const REFEREE_EGRESS_CONFIG_FILE =
  'authorized-egress.referee-provided.json'
export const REFEREE_EGRESS_STATE_FILE =
  'redscope-egress-referee-provided-state.json'

type EnsureRefereeEgressConfigResult = {
  filePath: string
  created: boolean
  error: Error | null
}

type RefereeEgressTemplate = {
  policy?: {
    statePath?: string
    notes?: string[]
  }
}

export function getPreferredRefereeEgressConfigFilePath(): string {
  return getPreferredUserConfigFile(REFEREE_EGRESS_CONFIG_FILE)
}

export function getRefereeEgressConfigFilePaths(): string[] {
  return getUserConfigFiles(REFEREE_EGRESS_CONFIG_FILE)
}

export function getExistingRefereeEgressConfigFilePath(): string | undefined {
  return uniquePaths(getRefereeEgressConfigFilePaths()).find(path =>
    existsSync(path),
  )
}

export function ensureUserRefereeEgressConfigFile(): EnsureRefereeEgressConfigResult {
  const filePath = getPreferredRefereeEgressConfigFilePath()
  if (existsSync(filePath)) {
    return { filePath, created: false, error: null }
  }

  try {
    const template = readBundledRefereeEgressTemplate()
    const content = prepareUserRefereeEgressConfigContent(template, filePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    return { filePath, created: true, error: null }
  } catch (error) {
    return {
      filePath,
      created: false,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

function readBundledRefereeEgressTemplate(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const argvEntry = process.argv[1] ? dirname(process.argv[1]) : undefined
  const candidates = [
    process.env.REDSCOPE_REFEREE_EGRESS_TEMPLATE_PATH,
    resolve(moduleDir, '../../tools', REFEREE_EGRESS_CONFIG_FILE),
    resolve(moduleDir, '../tools', REFEREE_EGRESS_CONFIG_FILE),
    argvEntry
      ? resolve(argvEntry, '../tools', REFEREE_EGRESS_CONFIG_FILE)
      : undefined,
    argvEntry
      ? resolve(argvEntry, '../../tools', REFEREE_EGRESS_CONFIG_FILE)
      : undefined,
    resolve(process.cwd(), 'tools', REFEREE_EGRESS_CONFIG_FILE),
  ].filter((path): path is string => Boolean(path))

  for (const candidate of uniquePaths(candidates)) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8')
    }
  }

  throw new Error(
    `Could not find bundled ${REFEREE_EGRESS_CONFIG_FILE} template`,
  )
}

function prepareUserRefereeEgressConfigContent(
  template: string,
  targetFilePath: string,
): string {
  const parsed = JSON.parse(template) as RefereeEgressTemplate
  parsed.policy ??= {}
  parsed.policy.statePath = join(
    dirname(targetFilePath),
    REFEREE_EGRESS_STATE_FILE,
  )
  parsed.policy.notes ??= []
  if (
    !parsed.policy.notes.includes(
      'This user-level copy is safe to edit; RedScope will not overwrite it after creation.',
    )
  ) {
    parsed.policy.notes.push(
      'This user-level copy is safe to edit; RedScope will not overwrite it after creation.',
    )
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}
