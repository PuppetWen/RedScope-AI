import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  getPreferredStateFilePath,
  getStateFilePaths,
} from './accounts.js'

export interface AccessConfig {
  policy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
}

interface PendingEntry {
  userId: string
  expiresAt: number
}

function configPath(): string {
  return getPreferredStateFilePath('access.json')
}

function pendingPath(): string {
  return getPreferredStateFilePath('pending-pairings.json')
}

function loadPending(): Record<string, PendingEntry> {
  for (const path of getStateFilePaths('pending-pairings.json')) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, PendingEntry>
    } catch {
      return {}
    }
  }
  return {}
}

function savePending(data: Record<string, PendingEntry>): void {
  writeFileSync(pendingPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function loadAccessConfig(): AccessConfig {
  for (const path of getStateFilePaths('access.json')) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as AccessConfig
    } catch {
      return { policy: 'pairing', allowFrom: [] }
    }
  }
  return { policy: 'pairing', allowFrom: [] }
}

export function saveAccessConfig(config: AccessConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
}

export function isAllowed(userId: string): boolean {
  const config = loadAccessConfig()
  if (config.policy === 'disabled') return true
  return config.allowFrom.includes(userId)
}

export function addPendingPairing(userId: string): string {
  const pending = loadPending()
  const now = Date.now()

  for (const code of Object.keys(pending)) {
    if (pending[code]!.expiresAt < now) {
      delete pending[code]
    }
  }

  for (const [code, entry] of Object.entries(pending)) {
    if (entry.userId === userId) {
      savePending(pending)
      return code
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000))
  pending[code] = { userId, expiresAt: now + 10 * 60 * 1000 }
  savePending(pending)
  return code
}

export function confirmPairing(code: string): string | null {
  const pending = loadPending()
  const entry = pending[code]
  if (!entry || entry.expiresAt < Date.now()) {
    delete pending[code]
    savePending(pending)
    return null
  }

  delete pending[code]
  savePending(pending)

  const config = loadAccessConfig()
  if (!config.allowFrom.includes(entry.userId)) {
    config.allowFrom.push(entry.userId)
    saveAccessConfig(config)
  }

  return entry.userId
}
