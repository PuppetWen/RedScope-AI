#!/usr/bin/env bun
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { extname, normalize } from 'path'

type NpmPackFile = {
  path: string
}

type NpmPackEntry = {
  files?: NpmPackFile[]
}

export type PublishGuardFinding = {
  file?: string
  message: string
}

const FORBIDDEN_PACKAGE_PATH_PARTS = [
  '.claude/',
  '.redscope/',
  'tools/outputs/',
  'tools/memory/',
  'tools/manifests/',
]

const FORBIDDEN_PACKAGE_BASENAMES = new Set([
  '.env',
  '.env.local',
  'env.config',
  'settings.json',
  'settings.local.json',
])

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.br',
  '.dll',
  '.dylib',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.node',
  '.png',
  '.so',
  '.tar',
  '.tgz',
  '.wasm',
  '.webp',
  '.zip',
])

const SENSITIVE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GROK_API_KEY',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'REDSCOPE_API_KEY',
  'REDSCOPE_AUTH_TOKEN',
]

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'Anthropic/OpenAI-style API key',
    pattern: /\bsk-(?:ant|proj|or-v1|live|svcacct)-[A-Za-z0-9._-]{20,}\b/g,
  },
  {
    name: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g,
  },
  {
    name: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    name: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'configured secret assignment',
    pattern:
      /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|DEEPSEEK_API_KEY|GEMINI_API_KEY|GROK_API_KEY|OPENAI_API_KEY|REDSCOPE_API_KEY|REDSCOPE_AUTH_TOKEN)[ \t]*=[ \t]*(?!["']?(?:$|<|your-|example|test|xxx|sk-test))["']?[^\s"'#]{12,}/gi,
  },
]

const EXPECTED_PACKAGE_NAME = '@redscope-ai/redscope'
const REQUIRED_RUNTIME_DEPENDENCIES = ['undici']

type PackageMetadata = {
  name?: string
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function parseNpmPackJson(stdout: string): NpmPackEntry[] {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('npm pack --json did not return a JSON array')
  }
  return JSON.parse(stdout.slice(start, end + 1)) as NpmPackEntry[]
}

export function isForbiddenPackagePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/')
  const basename = parts[parts.length - 1] ?? ''
  if (FORBIDDEN_PACKAGE_BASENAMES.has(basename)) return true
  return FORBIDDEN_PACKAGE_PATH_PARTS.some(part => normalized.includes(part))
}

export function findPackagedSecretFindings(
  content: string,
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): PublishGuardFinding[] {
  const findings: PublishGuardFinding[] = []

  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(content)) {
      findings.push({
        file: filePath,
        message: `${name} pattern found in packaged file`,
      })
    }
  }

  for (const key of SENSITIVE_ENV_KEYS) {
    const value = env[key]
    if (!value || isPlaceholderSecretValue(value)) continue
    if (content.includes(value)) {
      findings.push({
        file: filePath,
        message: `${key} value from the current environment is present in packaged output`,
      })
    }
  }

  return findings
}

function isPlaceholderSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 12) return true
  const lowered = trimmed.toLowerCase()
  return (
    lowered.includes('example') ||
    lowered.includes('placeholder') ||
    lowered.includes('your-') ||
    lowered === '<token>' ||
    lowered === '<api-key>' ||
    lowered.startsWith('sk-test')
  )
}

function shouldScanText(filePath: string): boolean {
  return !BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function getPackagedFiles(): string[] {
  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  if (result.status !== 0) {
    throw new Error(
      `npm pack --dry-run failed: ${result.stderr || result.stdout}`,
    )
  }

  const entries = parseNpmPackJson(result.stdout)
  return entries.flatMap(entry => entry.files?.map(file => file.path) ?? [])
}

function scanPackageFiles(files: string[]): PublishGuardFinding[] {
  const findings: PublishGuardFinding[] = []

  for (const filePath of files) {
    if (isForbiddenPackagePath(filePath)) {
      findings.push({
        file: filePath,
        message: 'forbidden local config, state, or output path is included in the package',
      })
      continue
    }

    if (!shouldScanText(filePath)) continue

    const localPath = normalize(filePath)
    if (!existsSync(localPath)) {
      findings.push({
        file: filePath,
        message: 'packaged file is listed by npm but missing from the working tree',
      })
      continue
    }

    const stat = statSync(localPath)
    if (stat.size > 8 * 1024 * 1024) continue

    const content = readFileSync(localPath, 'utf-8')
    if (content.includes('\u0000')) continue
    findings.push(...findPackagedSecretFindings(content, filePath))
  }

  return findings
}

export function validateRuntimeDependencies(
  pkg: PackageMetadata,
): PublishGuardFinding[] {
  const findings: PublishGuardFinding[] = []

  for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
    if (pkg.dependencies?.[dependency]) continue

    const location = pkg.devDependencies?.[dependency]
      ? 'currently only in devDependencies'
      : 'currently missing'

    findings.push({
      file: 'package.json',
      message: `runtime dependency "${dependency}" must be listed in dependencies (${location})`,
    })
  }

  return findings
}

function validatePackageMetadata(): PublishGuardFinding[] {
  const findings: PublishGuardFinding[] = []
  const pkg = JSON.parse(
    readFileSync('package.json', 'utf-8'),
  ) as PackageMetadata

  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    findings.push({
      file: 'package.json',
      message: `root npm package must publish as "${EXPECTED_PACKAGE_NAME}"`,
    })
  }

  if (pkg.bin?.redscope !== 'dist/cli-node.js') {
    findings.push({
      file: 'package.json',
      message: 'bin.redscope must point at dist/cli-node.js',
    })
  }

  findings.push(...validateRuntimeDependencies(pkg))

  return findings
}

export function runPublishGuard(): void {
  const findings = [
    ...validatePackageMetadata(),
    ...scanPackageFiles(getPackagedFiles()),
  ]

  if (findings.length > 0) {
    console.error('RedScope publish guard failed:')
    for (const finding of findings) {
      console.error(`- ${finding.file ? `${finding.file}: ` : ''}${finding.message}`)
    }
    process.exit(1)
  }

  console.log('RedScope publish guard passed: npm package metadata and packaged files are clean.')
}

if (import.meta.main) {
  runPublishGuard()
}
