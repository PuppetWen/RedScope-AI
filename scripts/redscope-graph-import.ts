#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { envPathFrom } from './redscope-env-config.ts'

type Options = {
  graphPath: string
  cypherPath?: string
  outputDir?: string
  retentionDays?: number
  accessLabel?: string
  owner?: string
  purpose?: string
  execute: boolean
  confirmImport: boolean
  cypherShell?: string
  uri?: string
  json: boolean
}

type GraphNode = {
  id: string
  kind: string
  label: string
  properties?: Record<string, unknown>
}

type GraphEdge = {
  id: string
  from: string
  to: string
  kind: string
  properties?: Record<string, unknown>
}

type MemoryGraph = {
  schemaVersion?: number
  generatedAt?: string
  sourceMemory?: string
  policy?: {
    localOnly?: boolean
    storesRawSecrets?: boolean
    storesResponseBodies?: boolean
    graphStore?: string
    notes?: string[]
  }
  summary?: {
    nodeCount?: number
    edgeCount?: number
  }
  nodes?: GraphNode[]
  edges?: GraphEdge[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultGraphPath = envPathFrom(
  ['REDSCOPE_MEMORY_GRAPH', 'REDSCOPE_TOOLS_MEMORY_GRAPH'],
  'tools/memory/redscope-memory-graph.json',
)
const defaultOutputRoot = envPathFrom(
  ['REDSCOPE_TOOLS_MEMORY_ROOT', 'REDSCOPE_MEMORY_ROOT'],
  'tools/memory',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-graph-import.ts --retention-days <n> --access-label <label> --owner <name> --purpose <text> [options]

Inputs:
  --graph <path>          Local graph JSON artifact (default: ${defaultGraphPath})
  --cypher <path>         Optional existing local Cypher artifact

Controls:
  --retention-days <n>    Required retention window, 1-365 days
  --access-label <label>  Required access-control label, e.g. redscope_internal
  --owner <name>          Required data owner
  --purpose <text>        Required import purpose

Output:
  --output-dir <path>     Import bundle directory
  --json                  Print machine-readable JSON

Optional execution:
  --execute               Run cypher-shell after writing the import bundle
  --confirm-import        Required with --execute
  --cypher-shell <path>   cypher-shell executable or command
  --uri <uri>             Neo4j URI (default: NEO4J_URI)

Execution also requires NEO4J_USERNAME and NEO4J_PASSWORD in the environment.
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    graphPath: defaultGraphPath,
    execute: false,
    confirmImport: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--execute') {
      options.execute = true
      continue
    }
    if (arg === '--confirm-import') {
      options.confirmImport = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()
    switch (arg) {
      case '--graph':
        options.graphPath = next
        break
      case '--cypher':
        options.cypherPath = next
        break
      case '--output-dir':
        options.outputDir = next
        break
      case '--retention-days':
        options.retentionDays = parsePositiveInteger(next, '--retention-days')
        break
      case '--access-label':
        options.accessLabel = next
        break
      case '--owner':
        options.owner = next
        break
      case '--purpose':
        options.purpose = next
        break
      case '--cypher-shell':
        options.cypherShell = next
        break
      case '--uri':
        options.uri = next
        break
      default:
        usage()
    }
    index++
  }

  return options
}

function projectPath(path: string): string {
  const relativePath = relative(repoRoot, path).split(sep).join('/')
  return relativePath || '.'
}

function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)
}

function assertInside(child: string, parent: string, label: string) {
  const relativePath = relative(parent, child)
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  ) {
    return
  }
  throw new Error(`${label} must stay inside ${projectPath(parent)}`)
}

function requireString(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function validateControls(options: Options) {
  if (!options.retentionDays) throw new Error('--retention-days is required')
  if (options.retentionDays > 365) {
    throw new Error('--retention-days must be 365 or less')
  }
  const accessLabel = requireString(options.accessLabel, '--access-label')
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(accessLabel)) {
    throw new Error('--access-label must be an alphanumeric graph label')
  }
  requireString(options.owner, '--owner')
  requireString(options.purpose, '--purpose')

  if (options.execute) {
    if (!options.confirmImport) {
      throw new Error('--execute requires --confirm-import')
    }
    requireString(options.cypherShell, '--cypher-shell')
    requireString(options.uri ?? process.env.NEO4J_URI, '--uri or NEO4J_URI')
    requireString(process.env.NEO4J_USERNAME, 'NEO4J_USERNAME')
    requireString(process.env.NEO4J_PASSWORD, 'NEO4J_PASSWORD')
  }
}

function validateGraph(graph: MemoryGraph) {
  if (!Array.isArray(graph.nodes)) throw new Error('graph artifact is missing nodes')
  if (!Array.isArray(graph.edges)) throw new Error('graph artifact is missing edges')
  if (graph.policy?.localOnly !== true) {
    throw new Error('graph policy.localOnly must be true')
  }
  if (graph.policy?.storesRawSecrets !== false) {
    throw new Error('graph policy.storesRawSecrets must be false')
  }
  if (graph.policy?.storesResponseBodies !== false) {
    throw new Error('graph policy.storesResponseBodies must be false')
  }
}

function cypherString(value: string): string {
  return JSON.stringify(value)
}

function graphNodeLabel(kind: string): string {
  return kind
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join('')
    .replace(/^[^A-Za-z]+/, '') || 'Unknown'
}

function graphRelationshipType(kind: string): string {
  const normalized = kind.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return /^[A-Z]/.test(normalized) ? normalized : `REL_${normalized}`
}

function renderCypherImport(
  graph: MemoryGraph,
  importId: string,
  options: Required<Pick<Options, 'retentionDays' | 'accessLabel' | 'owner' | 'purpose'>>,
): string {
  const importedAt = new Date().toISOString()
  const retentionExpiresAt = new Date(
    Date.now() + options.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString()
  const lines = [
    '// RedScope local graph import',
    '// Generated from sanitized local graph JSON/Cypher artifacts only.',
    'CREATE CONSTRAINT redscope_node_id IF NOT EXISTS FOR (n:RedScopeNode) REQUIRE n.id IS UNIQUE;',
    'CREATE CONSTRAINT redscope_import_id IF NOT EXISTS FOR (n:RedScopeImport) REQUIRE n.id IS UNIQUE;',
    `MERGE (i:RedScopeImport {id: ${cypherString(importId)}}) ` +
      `SET i.importedAt = ${cypherString(importedAt)}, ` +
      `i.retentionDays = ${options.retentionDays}, ` +
      `i.retentionExpiresAt = ${cypherString(retentionExpiresAt)}, ` +
      `i.accessLabel = ${cypherString(options.accessLabel)}, ` +
      `i.owner = ${cypherString(options.owner)}, ` +
      `i.purpose = ${cypherString(options.purpose)};`,
    '',
  ]

  for (const node of graph.nodes ?? []) {
    const label = graphNodeLabel(node.kind)
    lines.push(
      `MERGE (n:RedScopeNode:${label} {id: ${cypherString(node.id)}}) ` +
        `SET n.kind = ${cypherString(node.kind)}, ` +
        `n.label = ${cypherString(node.label)}, ` +
        `n.propertiesJson = ${cypherString(JSON.stringify(node.properties ?? {}))}, ` +
        `n.importId = ${cypherString(importId)}, ` +
        `n.accessLabel = ${cypherString(options.accessLabel)}, ` +
        `n.retentionExpiresAt = ${cypherString(retentionExpiresAt)};`,
    )
    lines.push(
      `MATCH (i:RedScopeImport {id: ${cypherString(importId)}}), ` +
        `(n:RedScopeNode {id: ${cypherString(node.id)}}) ` +
        `MERGE (i)-[:IMPORTS]->(n);`,
    )
  }

  lines.push('')
  for (const edge of graph.edges ?? []) {
    lines.push(
      `MATCH (a:RedScopeNode {id: ${cypherString(edge.from)}}), ` +
        `(b:RedScopeNode {id: ${cypherString(edge.to)}}) ` +
        `MERGE (a)-[r:${graphRelationshipType(edge.kind)} {id: ${cypherString(edge.id)}}]->(b) ` +
        `SET r.kind = ${cypherString(edge.kind)}, ` +
        `r.propertiesJson = ${cypherString(JSON.stringify(edge.properties ?? {}))}, ` +
        `r.importId = ${cypherString(importId)}, ` +
        `r.accessLabel = ${cypherString(options.accessLabel)}, ` +
        `r.retentionExpiresAt = ${cypherString(retentionExpiresAt)};`,
    )
  }

  return `${lines.join('\n')}\n`
}

function defaultOutputDir(graphPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = basename(graphPath).replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(defaultOutputRoot, 'graph-imports', `${stamp}-${base}`)
}

async function runCypherShell(
  cypherPath: string,
  options: Options,
): Promise<{ exitCode: number; stdoutPath: string; stderrPath: string }> {
  const stdoutPath = join(dirname(cypherPath), 'cypher-shell.stdout.txt')
  const stderrPath = join(dirname(cypherPath), 'cypher-shell.stderr.txt')
  const proc = Bun.spawn(
    [
      requireString(options.cypherShell, '--cypher-shell'),
      '-a',
      requireString(options.uri ?? process.env.NEO4J_URI, '--uri or NEO4J_URI'),
      '-u',
      requireString(process.env.NEO4J_USERNAME, 'NEO4J_USERNAME'),
      '-p',
      requireString(process.env.NEO4J_PASSWORD, 'NEO4J_PASSWORD'),
      '-f',
      cypherPath,
    ],
    {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  await writeFile(stdoutPath, stdout)
  await writeFile(stderrPath, stderr)
  return {
    exitCode,
    stdoutPath: projectPath(stdoutPath),
    stderrPath: projectPath(stderrPath),
  }
}

async function run(options: Options) {
  validateControls(options)

  const graphPath = resolveProjectPath(options.graphPath)
  assertInside(graphPath, repoRoot, 'graph path')
  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as MemoryGraph
  validateGraph(graph)

  const outputDir = resolveProjectPath(options.outputDir ?? defaultOutputDir(graphPath))
  assertInside(outputDir, repoRoot, 'output dir')
  await mkdir(outputDir, { recursive: true })

  const importId = `redscope-import-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const cypherPath = join(outputDir, 'import.cypher')
  const manifestPath = join(outputDir, 'import-manifest.json')
  const sourceCypher = options.cypherPath
    ? resolveProjectPath(options.cypherPath)
    : undefined
  if (sourceCypher) assertInside(sourceCypher, repoRoot, 'cypher path')

  const controls = {
    retentionDays: options.retentionDays!,
    accessLabel: requireString(options.accessLabel, '--access-label'),
    owner: requireString(options.owner, '--owner'),
    purpose: requireString(options.purpose, '--purpose'),
  }

  const cypher = sourceCypher
    ? await readFile(sourceCypher, 'utf8')
    : renderCypherImport(graph, importId, controls)
  await writeFile(cypherPath, cypher)

  let execution:
    | { exitCode: number; stdoutPath: string; stderrPath: string }
    | undefined
  if (options.execute) {
    execution = await runCypherShell(cypherPath, options)
    if (execution.exitCode !== 0) {
      throw new Error(`cypher-shell exited ${execution.exitCode}`)
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: options.execute ? 'executed' : 'prepared',
    importId,
    source: {
      graphPath: projectPath(graphPath),
      cypherPath: sourceCypher ? projectPath(sourceCypher) : undefined,
      graphGeneratedAt: graph.generatedAt,
      nodeCount: graph.nodes?.length ?? 0,
      edgeCount: graph.edges?.length ?? 0,
    },
    controls,
    policy: {
      localArtifactOnly: true,
      requiresRetentionControls: true,
      requiresAccessLabel: true,
      requiresExplicitExecuteAndConfirm: true,
      storesRawSecrets: false,
      storesResponseBodies: false,
    },
    files: {
      cypher: projectPath(cypherPath),
      manifest: projectPath(manifestPath),
    },
    execution,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2))
    return
  }

  console.log(`Prepared graph import ${importId}`)
  console.log(`  manifest: ${projectPath(manifestPath)}`)
  console.log(`  cypher: ${projectPath(cypherPath)}`)
}

run(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-graph-import: ${error.message}`)
  process.exit(1)
})
