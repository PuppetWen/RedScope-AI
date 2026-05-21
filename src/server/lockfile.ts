import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getPreferredUserConfigFile } from '../utils/redscopeCompat.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

export interface ServerLockInfo {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

const LOCK_FILE = 'server-lock.json'

function getServerLockPath(): string {
  return getPreferredUserConfigFile(LOCK_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseLock(value: unknown): ServerLockInfo | null {
  if (!isRecord(value)) return null
  if (
    typeof value.pid !== 'number' ||
    typeof value.port !== 'number' ||
    typeof value.host !== 'string' ||
    typeof value.httpUrl !== 'string' ||
    typeof value.startedAt !== 'number'
  ) {
    return null
  }
  return {
    pid: value.pid,
    port: value.port,
    host: value.host,
    httpUrl: value.httpUrl,
    startedAt: value.startedAt,
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      isRecord(error) && (error.code === 'EPERM' || error.code === 'EACCES')
    )
  }
}

async function healthCheck(httpUrl: string): Promise<boolean> {
  if (!httpUrl.startsWith('http://') && !httpUrl.startsWith('https://')) {
    return true
  }
  try {
    const response = await fetch(`${httpUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(750),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function writeServerLock(info: ServerLockInfo): Promise<void> {
  const lockPath = getServerLockPath()
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, `${jsonStringify(info)}\n`, 'utf8')
}

export async function removeServerLock(): Promise<void> {
  await rm(getServerLockPath(), { force: true })
}

export async function probeRunningServer(): Promise<ServerLockInfo | null> {
  const lockPath = getServerLockPath()
  let lock: ServerLockInfo | null = null
  try {
    lock = parseLock(jsonParse(await readFile(lockPath, 'utf8')))
  } catch {
    return null
  }

  if (!lock) {
    await removeServerLock()
    return null
  }

  if (!isPidAlive(lock.pid) || !(await healthCheck(lock.httpUrl))) {
    await removeServerLock()
    return null
  }

  return lock
}
