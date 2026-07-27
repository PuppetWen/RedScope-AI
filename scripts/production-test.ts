#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const distDir = join(projectRoot, 'dist')
const flags = new Set(process.argv.slice(2))
const knownFlags = new Set(['--offline', '--verbose', '--bun'])
const unknownFlags = [...flags].filter(flag => !knownFlags.has(flag))

if (unknownFlags.length > 0) {
  console.error(`Unknown option(s): ${unknownFlags.join(', ')}`)
  console.error(
    'Usage: bun run scripts/production-test.ts [--offline] [--verbose] [--bun]',
  )
  process.exit(2)
}

const useBun = flags.has('--bun')
const verbose = flags.has('--verbose')
const offline = flags.has('--offline')
const runtime = useBun ? process.execPath : 'node'
const entryName = useBun ? 'cli-bun.js' : 'cli-node.js'
const entryPath = join(distDir, entryName)
const manifest = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
) as { version?: string }
const expectedVersion = manifest.version

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path)
    }
  }
  return files
}

async function verifyArtifacts(): Promise<void> {
  const required = ['cli.js', 'cli-node.js', 'cli-bun.js']
  const missing: string[] = []
  for (const file of required) {
    if (!(await isNonEmptyFile(join(distDir, file)))) missing.push(file)
  }
  if (missing.length > 0) {
    throw new Error(
      `missing build artifacts: ${missing.join(', ')}; run bun run build`,
    )
  }

  const wrapper = await readFile(entryPath, 'utf8')
  const expectedShebang = useBun
    ? '#!/usr/bin/env -S bun --no-env-file'
    : '#!/usr/bin/env node'
  if (
    !wrapper.startsWith(expectedShebang) ||
    !wrapper.includes('import "./cli.js"')
  ) {
    throw new Error(`${entryName} is not a valid production wrapper`)
  }
}

async function verifyChunkReferences(): Promise<number> {
  const files = await collectJavaScriptFiles(distDir)
  const missing = new Set<string>()
  const relativeImport =
    /(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/g

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(relativeImport)) {
      const target = resolve(dirname(file), match[1])
      if (!(await isNonEmptyFile(target))) {
        missing.add(
          `${relative(projectRoot, file)} -> ${relative(projectRoot, target)}`,
        )
      }
    }
  }

  if (missing.size > 0) {
    throw new Error(
      `broken JavaScript references:\n${[...missing].join('\n')}`,
    )
  }
  return files.length
}

function runCli(args: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise(resolveResult => {
    const child = spawn(runtime, [entryPath, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CI: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        NODE_ENV: 'production',
        REDSCOPE_OFFLINE_TEST: offline ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ exitCode, stdout, stderr, timedOut })
    }

    child.on('error', error => {
      stderr += `${error.message}\n`
      finish(null)
    })
    child.on('close', finish)
  })
}

function assertCommand(
  name: string,
  result: CommandResult,
  predicate: (output: string) => boolean,
): void {
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (
    result.timedOut ||
    result.exitCode !== 0 ||
    !predicate(output)
  ) {
    throw new Error(
      `${name} failed (exit=${result.exitCode}, timeout=${result.timedOut})\n${output}`,
    )
  }
  if (verbose) {
    console.log(`\n[${name}]\n${output}`)
  }
}

async function main(): Promise<void> {
  console.log(
    `RedScope production smoke test (${useBun ? 'Bun' : 'Node'}, ${offline ? 'offline' : 'local-only'})`,
  )

  await verifyArtifacts()
  console.log(`✓ Production wrappers`)

  const fileCount = await verifyChunkReferences()
  console.log(`✓ ${fileCount} JavaScript files have valid relative imports`)

  const versionResult = await runCli(['--version'])
  assertCommand(
    '--version',
    versionResult,
    output => !!expectedVersion && output.includes(expectedVersion),
  )
  console.log(`✓ Version command (${expectedVersion})`)

  const helpResult = await runCli(['--help'])
  assertCommand(
    '--help',
    helpResult,
    output =>
      output.includes('Usage: redscope') &&
      output.includes('RedScope AI'),
  )
  console.log(`✓ Help command`)

  console.log('\nProduction smoke test passed')
}

main().catch(error => {
  console.error(
    `\nProduction smoke test failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exitCode = 1
})
