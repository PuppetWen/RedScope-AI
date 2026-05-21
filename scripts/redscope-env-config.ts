import { applyEnvConfigEnvironmentVariables } from '../src/utils/envConfig.ts'

applyEnvConfigEnvironmentVariables()

export function envPath(key: string, fallback: string): string {
  const value = process.env[key]?.trim()
  return value ? value : fallback
}

export function envPathFrom(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return fallback
}

export function envNumber(key: string, fallback: number): number {
  const value = process.env[key]?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function envList(key: string, fallback: string[]): string[] {
  const value = process.env[key]?.trim()
  if (!value) return fallback
  return value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
}
