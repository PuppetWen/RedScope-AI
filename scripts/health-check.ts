#!/usr/bin/env bun

import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type HealthLevel = 'pass' | 'warning' | 'error'

type HealthResult = {
  level: HealthLevel
  name: string
  detail: string
}

type PackageManifest = {
  name?: string
  version?: string
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
}

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const results: HealthResult[] = []

function report(level: HealthLevel, name: string, detail: string): void {
  results.push({ level, name, detail })
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    await access(path, constants.R_OK)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function formatPath(path: string): string {
  const localPath = relative(projectRoot, path)
  return localPath || '.'
}

function bunVersionIsSupported(version: string): boolean {
  const [major = 0, minor = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10))
  return major > 1 || (major === 1 && minor >= 2)
}

async function checkManifest(): Promise<PackageManifest | null> {
  const manifestPath = join(projectRoot, 'package.json')
  try {
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as PackageManifest
    if (!manifest.name || !manifest.version) {
      report(
        'error',
        'Package manifest',
        'package.json is missing name or version',
      )
      return manifest
    }
    report(
      'pass',
      'Package manifest',
      `${manifest.name} v${manifest.version}`,
    )
    return manifest
  } catch (error) {
    report(
      'error',
      'Package manifest',
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

function checkRuntime(manifest: PackageManifest | null): void {
  const bunVersion = Bun.version
  if (bunVersionIsSupported(bunVersion)) {
    report(
      'pass',
      'Bun runtime',
      `${bunVersion} (${manifest?.engines?.bun ?? 'no engine constraint'})`,
    )
  } else {
    report(
      'error',
      'Bun runtime',
      `${bunVersion}; RedScope requires Bun >=1.2.0`,
    )
  }
}

async function checkSourceLayout(): Promise<boolean> {
  const sourceEntry = join(projectRoot, 'src', 'entrypoints', 'cli.tsx')
  const hasSource = await isReadableFile(sourceEntry)
  if (!hasSource) {
    report(
      'pass',
      'Installation layout',
      'packaged installation (source tree not required)',
    )
    return false
  }

  const requiredPaths = [
    sourceEntry,
    join(projectRoot, 'build.ts'),
    join(projectRoot, 'src', 'utils', 'vendor', 'ripgrep'),
    join(projectRoot, 'vendor', 'audio-capture'),
  ]
  const missing: string[] = []
  for (const path of requiredPaths) {
    if (!(await isReadableFile(path)) && !(await isDirectory(path))) {
      missing.push(formatPath(path))
    }
  }

  if (missing.length > 0) {
    report(
      'error',
      'Source layout',
      `missing required paths: ${missing.join(', ')}`,
    )
  } else {
    report('pass', 'Source layout', 'entrypoint and vendored assets found')
  }
  return true
}

async function checkScriptReferences(
  manifest: PackageManifest | null,
  sourceCheckout: boolean,
): Promise<void> {
  if (!manifest?.scripts || !sourceCheckout) return

  const referenced = new Set<string>()
  const scriptReference =
    /(?:^|\s)(scripts\/[A-Za-z0-9_.\-/]+\.(?:ts|js|mjs|cjs))/g
  for (const command of Object.values(manifest.scripts)) {
    for (const match of command.matchAll(scriptReference)) {
      referenced.add(match[1])
    }
  }

  const missing: string[] = []
  for (const script of referenced) {
    if (!(await isReadableFile(join(projectRoot, script)))) {
      missing.push(script)
    }
  }

  if (missing.length > 0) {
    report(
      'error',
      'Script entrypoints',
      `package.json references missing files: ${missing.join(', ')}`,
    )
  } else {
    report(
      'pass',
      'Script entrypoints',
      `${referenced.size} referenced script files found`,
    )
  }
}

function checkDependencies(
  manifest: PackageManifest | null,
  sourceCheckout: boolean,
): void {
  const requiredPackages = sourceCheckout
    ? ['react', '@anthropic/ink', '@anthropic-ai/sdk', 'openai']
    : Object.keys(manifest?.dependencies ?? {})
  const missing: string[] = []
  for (const packageName of requiredPackages) {
    try {
      Bun.resolveSync(packageName, projectRoot)
    } catch {
      missing.push(packageName)
    }
  }

  if (missing.length > 0) {
    report(
      'error',
      'Dependencies',
      `unresolved packages: ${missing.join(', ')}; run bun install`,
    )
  } else {
    report(
      'pass',
      'Dependencies',
      `${requiredPackages.length} core packages resolved`,
    )
  }
}

async function checkBuildArtifacts(): Promise<void> {
  const distDir = join(projectRoot, 'dist')
  if (!(await isDirectory(distDir))) {
    report(
      'warning',
      'Production build',
      'dist is absent; run bun run build before production testing',
    )
    return
  }

  const requiredFiles = ['cli.js', 'cli-node.js', 'cli-bun.js']
  const missing: string[] = []
  for (const file of requiredFiles) {
    if (!(await isReadableFile(join(distDir, file)))) missing.push(file)
  }

  const jsFiles = (await readdir(distDir)).filter(file =>
    file.endsWith('.js'),
  )
  if (missing.length > 0) {
    report(
      'error',
      'Production build',
      `missing or empty artifacts: ${missing.join(', ')}`,
    )
  } else {
    report(
      'pass',
      'Production build',
      `${jsFiles.length} JavaScript artifacts; Node and Bun entries found`,
    )
  }
}

function printSummary(): void {
  const glyph: Record<HealthLevel, string> = {
    pass: '✓',
    warning: '!',
    error: '✗',
  }
  console.log('RedScope AI health check\n')
  for (const result of results) {
    console.log(
      `${glyph[result.level]} ${result.name}: ${result.detail}`,
    )
  }

  const errors = results.filter(result => result.level === 'error').length
  const warnings = results.filter(
    result => result.level === 'warning',
  ).length
  console.log(
    `\n${results.length - errors - warnings} passed, ${warnings} warnings, ${errors} errors`,
  )
  if (errors > 0) process.exitCode = 1
}

const manifest = await checkManifest()
checkRuntime(manifest)
const sourceCheckout = await checkSourceLayout()
await checkScriptReferences(manifest, sourceCheckout)
checkDependencies(manifest, sourceCheckout)
await checkBuildArtifacts()
printSummary()
