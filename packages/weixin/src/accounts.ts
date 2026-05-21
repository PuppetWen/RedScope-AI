import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  getPreferredUserConfigSubdir,
  getUserConfigSubdirs,
  uniquePaths,
} from '../../../src/utils/redscopeCompat.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export interface AccountData {
  token: string
  baseUrl: string
  userId?: string
  savedAt: string
}

export function getStateDir(): string {
  const dir =
    process.env.WEIXIN_STATE_DIR ||
    getPreferredUserConfigSubdir(join('channels', 'weixin'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getStateDirs(): string[] {
  if (process.env.WEIXIN_STATE_DIR) {
    return [process.env.WEIXIN_STATE_DIR]
  }
  return getUserConfigSubdirs(join('channels', 'weixin'))
}

export function getStateFilePaths(filename: string): string[] {
  return uniquePaths(getStateDirs().map(dir => join(dir, filename)))
}

export function getPreferredStateFilePath(filename: string): string {
  return join(getStateDir(), filename)
}

export function loadAccount(): AccountData | null {
  for (const path of getStateFilePaths('account.json')) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as AccountData
    } catch {
      return null
    }
  }
  return null
}

export function saveAccount(data: AccountData): void {
  const path = getPreferredStateFilePath('account.json')
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  chmodSync(path, 0o600)
}

export function clearAccount(): void {
  for (const path of getStateFilePaths('account.json')) {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
}
