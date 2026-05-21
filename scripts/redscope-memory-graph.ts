#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
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
  memoryPath?: string
  memoryRoot: string
  outputPath?: string
  cypherPath?: string
  dryRun: boolean
  json: boolean
}

type MemoryRun = {
  id?: string
  runDir?: string
  observedAt?: string
  profile?: {
    id?: string
    name?: string
    riskLevel?: string
  }
  target?: {
    kind?: string
    value?: string
    host?: string
    url?: string
    repositoryPath?: string
    artifactPath?: string
    matchedBy?: string[]
  }
  authorization?: {
    owner?: string
    reference?: string | null
    scopePath?: string
  }
  summary?: {
    findingsTotal?: number
    highestSeverity?: string
    evidenceCount?: number
  }
}

type MemoryAsset = {
  id?: string
  kind?: string
  value?: string
  owner?: string
  profiles?: string[]
  scopeMatches?: string[]
  runSummaries?: Array<{
    runId?: string
    runDir?: string
    profile?: string
    highestSeverity?: string
    findingsTotal?: number
  }>
}

type MemoryDecision = {
  id?: string
  runId?: string
  type?: string
  profile?: string
  stepId?: string
  tool?: string
  outcome?: string
}

type MemoryToolOutput = {
  id?: string
  runId?: string
  stepId?: string
  tool?: string
  status?: string
  outputFiles?: string[]
}

type MemoryLesson = {
  id?: string
  category?: string
  title?: string
  confidence?: string
  evidenceRuns?: string[]
}

type RedScopeMemory = {
  schemaVersion?: number
  generatedAt?: string
  updatedAt?: string
  runs?: MemoryRun[]
  assets?: MemoryAsset[]
  decisions?: MemoryDecision[]
  toolOutputs?: MemoryToolOutput[]
  lessons?: MemoryLesson[]
}

type GraphNode = {
  id: string
  kind:
    | 'run'
    | 'asset'
    | 'profile'
    | 'owner'
    | 'decision'
    | 'tool-output'
    | 'tool'
    | 'lesson'
  label: string
  properties: Record<string, unknown>
}

type GraphEdge = {
  id: string
  from: string
  to: string
  kind:
    | 'uses-profile'
    | 'targets'
    | 'owned-by'
    | 'records-decision'
    | 'produced-tool-output'
    | 'uses-tool'
    | 'supports-lesson'
    | 'asset-seen-in-run'
  properties: Record<string, unknown>
}

type MemoryGraph = {
  schemaVersion: 1
  generatedAt: string
  sourceMemory: string
  policy: {
    localOnly: true
    storesRawSecrets: false
    storesResponseBodies: false
    graphStore: 'json'
    notes: string[]
  }
  summary: {
    nodeCount: number
    edgeCount: number
    nodeCounts: Record<string, number>
    edgeCounts: Record<string, number>
  }
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const defaultMemoryRoot = envPathFrom(
  ['REDSCOPE_TOOLS_MEMORY_ROOT', 'REDSCOPE_MEMORY_ROOT'],
  'tools/memory',
)

function usage(exitCode = 2): never {
  const text = `
Usage:
  bun run scripts/redscope-memory-graph.ts [options]

Options:
  --memory <path>       Memory JSON path (default: <memory-root>/redscope-memory.json)
  --memory-root <path>  Memory root (default: ${defaultMemoryRoot})
  --output <path>       Graph JSON output (default: <memory-root>/redscope-memory-graph.json)
  --cypher-output <path> Optional Neo4j/Cypher import file
  --dry-run             Print graph without writing files
  --json                Print machine-readable JSON
`.trim()
  console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    memoryRoot: defaultMemoryRoot,
    dryRun: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()
    switch (arg) {
      case '--memory':
        options.memoryPath = next
        break
      case '--memory-root':
        options.memoryRoot = next
        break
      case '--output':
        options.outputPath = next
        break
      case '--cypher-output':
      case '--neo4j-cypher':
        options.cypherPath = next
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

function stableId(prefix: string, raw: string | undefined, fallback: string): string {
  const source = raw?.trim() || fallback
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return `${prefix}:${normalized || fallback}`
}

function addCount(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode) {
  if (!nodes.has(node.id)) nodes.set(node.id, node)
}

function addEdge(edges: Map<string, GraphEdge>, edge: Omit<GraphEdge, 'id'>) {
  const id = `${edge.kind}:${edge.from}->${edge.to}`
  if (!edges.has(id)) edges.set(id, { id, ...edge })
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function cypherString(value: string): string {
  return JSON.stringify(value)
}

function graphNodeLabel(kind: GraphNode['kind']): string {
  switch (kind) {
    case 'run':
      return 'Run'
    case 'asset':
      return 'Asset'
    case 'profile':
      return 'Profile'
    case 'owner':
      return 'Owner'
    case 'decision':
      return 'Decision'
    case 'tool-output':
      return 'ToolOutput'
    case 'tool':
      return 'Tool'
    case 'lesson':
      return 'Lesson'
  }
}

function graphRelationshipType(kind: GraphEdge['kind']): string {
  return kind.toUpperCase().replace(/-/g, '_')
}

function renderCypherImport(graph: MemoryGraph): string {
  const lines = [
    '// RedScope local memory graph import',
    '// Generated from local summaries only; no raw evidence bodies, secrets, payloads, or response bodies are included.',
    'CREATE CONSTRAINT redscope_node_id IF NOT EXISTS FOR (n:RedScopeNode) REQUIRE n.id IS UNIQUE;',
    '',
  ]

  for (const node of graph.nodes) {
    const label = graphNodeLabel(node.kind)
    lines.push(
      `MERGE (n:RedScopeNode:${label} {id: ${cypherString(node.id)}}) ` +
        `SET n.kind = ${cypherString(node.kind)}, ` +
        `n.label = ${cypherString(node.label)}, ` +
        `n.propertiesJson = ${cypherString(JSON.stringify(node.properties))};`,
    )
  }

  lines.push('')
  for (const edge of graph.edges) {
    lines.push(
      `MATCH (a:RedScopeNode {id: ${cypherString(edge.from)}}), ` +
        `(b:RedScopeNode {id: ${cypherString(edge.to)}}) ` +
        `MERGE (a)-[r:${graphRelationshipType(edge.kind)} {id: ${cypherString(edge.id)}}]->(b) ` +
        `SET r.kind = ${cypherString(edge.kind)}, ` +
        `r.propertiesJson = ${cypherString(JSON.stringify(edge.properties))};`,
    )
  }

  return `${lines.join('\n')}\n`
}

async function readMemory(path: string): Promise<RedScopeMemory> {
  return JSON.parse(await readFile(path, 'utf8')) as RedScopeMemory
}

function buildGraph(memory: RedScopeMemory, sourceMemory: string): MemoryGraph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  for (const run of memory.runs ?? []) {
    const runId = stableId('run', run.id, readString(run.runDir) ?? 'unknown-run')
    addNode(nodes, {
      id: runId,
      kind: 'run',
      label: readString(run.id) ?? readString(run.runDir) ?? 'unknown run',
      properties: {
        runDir: run.runDir,
        observedAt: run.observedAt,
        highestSeverity: run.summary?.highestSeverity,
        findingsTotal: run.summary?.findingsTotal,
        evidenceCount: run.summary?.evidenceCount,
      },
    })

    if (run.profile?.id) {
      const profileId = stableId('profile', run.profile.id, 'unknown-profile')
      addNode(nodes, {
        id: profileId,
        kind: 'profile',
        label: run.profile.id,
        properties: {
          name: run.profile.name,
          riskLevel: run.profile.riskLevel,
        },
      })
      addEdge(edges, {
        from: runId,
        to: profileId,
        kind: 'uses-profile',
        properties: {},
      })
    }

    const targetValue = readString(run.target?.value)
    if (targetValue) {
      const assetId = stableId('asset', `${run.target?.kind}:${targetValue}`, targetValue)
      addNode(nodes, {
        id: assetId,
        kind: 'asset',
        label: targetValue,
        properties: {
          kind: run.target?.kind,
          host: run.target?.host,
          url: run.target?.url,
          repositoryPath: run.target?.repositoryPath,
          artifactPath: run.target?.artifactPath,
          matchedBy: run.target?.matchedBy,
        },
      })
      addEdge(edges, {
        from: runId,
        to: assetId,
        kind: 'targets',
        properties: {
          matchedBy: run.target?.matchedBy ?? [],
        },
      })
    }

    const owner = readString(run.authorization?.owner)
    if (owner) {
      const ownerId = stableId('owner', owner, 'unknown-owner')
      addNode(nodes, {
        id: ownerId,
        kind: 'owner',
        label: owner,
        properties: {
          scopePath: run.authorization?.scopePath,
          authorizationReference: run.authorization?.reference,
        },
      })
      addEdge(edges, {
        from: runId,
        to: ownerId,
        kind: 'owned-by',
        properties: {},
      })
    }
  }

  for (const asset of memory.assets ?? []) {
    const assetId = stableId(
      'asset',
      asset.id,
      `${asset.kind ?? 'asset'}:${asset.value ?? 'unknown'}`,
    )
    addNode(nodes, {
      id: assetId,
      kind: 'asset',
      label: readString(asset.value) ?? assetId,
      properties: {
        kind: asset.kind,
        owner: asset.owner,
        profiles: asset.profiles ?? [],
        scopeMatches: asset.scopeMatches ?? [],
      },
    })
    if (asset.owner) {
      const ownerId = stableId('owner', asset.owner, 'unknown-owner')
      addNode(nodes, {
        id: ownerId,
        kind: 'owner',
        label: asset.owner,
        properties: {},
      })
      addEdge(edges, {
        from: assetId,
        to: ownerId,
        kind: 'owned-by',
        properties: {},
      })
    }
    for (const summary of asset.runSummaries ?? []) {
      const runId = stableId('run', summary.runId, summary.runDir ?? 'unknown-run')
      addEdge(edges, {
        from: assetId,
        to: runId,
        kind: 'asset-seen-in-run',
        properties: {
          profile: summary.profile,
          highestSeverity: summary.highestSeverity,
          findingsTotal: summary.findingsTotal,
        },
      })
    }
  }

  for (const decision of memory.decisions ?? []) {
    const decisionId = stableId('decision', decision.id, 'unknown-decision')
    addNode(nodes, {
      id: decisionId,
      kind: 'decision',
      label: decision.type ?? decisionId,
      properties: {
        profile: decision.profile,
        stepId: decision.stepId,
        tool: decision.tool,
        outcome: decision.outcome,
      },
    })
    if (decision.runId) {
      addEdge(edges, {
        from: stableId('run', decision.runId, 'unknown-run'),
        to: decisionId,
        kind: 'records-decision',
        properties: {},
      })
    }
  }

  for (const output of memory.toolOutputs ?? []) {
    const outputId = stableId('tool-output', output.id, 'unknown-tool-output')
    addNode(nodes, {
      id: outputId,
      kind: 'tool-output',
      label: output.stepId ?? output.tool ?? outputId,
      properties: {
        stepId: output.stepId,
        tool: output.tool,
        status: output.status,
        outputFileCount: readStringList(output.outputFiles).length,
      },
    })
    if (output.runId) {
      addEdge(edges, {
        from: stableId('run', output.runId, 'unknown-run'),
        to: outputId,
        kind: 'produced-tool-output',
        properties: {},
      })
    }
    if (output.tool) {
      const toolId = stableId('tool', output.tool, 'unknown-tool')
      addNode(nodes, {
        id: toolId,
        kind: 'tool',
        label: output.tool,
        properties: {},
      })
      addEdge(edges, {
        from: outputId,
        to: toolId,
        kind: 'uses-tool',
        properties: {},
      })
    }
  }

  for (const lesson of memory.lessons ?? []) {
    const lessonId = stableId('lesson', lesson.id, 'unknown-lesson')
    addNode(nodes, {
      id: lessonId,
      kind: 'lesson',
      label: readString(lesson.title) ?? lessonId,
      properties: {
        category: lesson.category,
        confidence: lesson.confidence,
      },
    })
    for (const run of lesson.evidenceRuns ?? []) {
      addEdge(edges, {
        from: stableId('run', run, 'unknown-run'),
        to: lessonId,
        kind: 'supports-lesson',
        properties: {},
      })
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))
  const edgeList = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id))
  const nodeCounts: Record<string, number> = {}
  const edgeCounts: Record<string, number> = {}
  for (const node of nodeList) addCount(nodeCounts, node.kind)
  for (const edge of edgeList) addCount(edgeCounts, edge.kind)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceMemory,
    policy: {
      localOnly: true,
      storesRawSecrets: false,
      storesResponseBodies: false,
      graphStore: 'json',
      notes: [
        'This graph is derived from RedScope local memory summaries only.',
        'It stores node and edge metadata for review, not raw findings, raw evidence, secrets, payloads, response bodies, or artifact contents.',
        'Use this JSON graph as a lightweight export; no database or external service is contacted.',
      ],
    },
    summary: {
      nodeCount: nodeList.length,
      edgeCount: edgeList.length,
      nodeCounts,
      edgeCounts,
    },
    nodes: nodeList,
    edges: edgeList,
  }
}

async function run(options: Options) {
  const memoryRoot = resolveProjectPath(options.memoryRoot)
  assertInside(memoryRoot, repoRoot, 'memory root')
  const memoryPath = resolveProjectPath(
    options.memoryPath ?? join(memoryRoot, 'redscope-memory.json'),
  )
  assertInside(memoryPath, repoRoot, 'memory path')
  const outputPath = resolveProjectPath(
    options.outputPath ?? join(memoryRoot, 'redscope-memory-graph.json'),
  )
  assertInside(outputPath, repoRoot, 'graph output path')
  const cypherPath = options.cypherPath
    ? resolveProjectPath(options.cypherPath)
    : undefined
  if (cypherPath) assertInside(cypherPath, repoRoot, 'cypher output path')

  const memory = await readMemory(memoryPath)
  const graph = buildGraph(memory, projectPath(memoryPath))

  if (options.dryRun) {
    console.log(JSON.stringify(graph, null, 2))
    return
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(graph, null, 2)}\n`)
  if (cypherPath) {
    await mkdir(dirname(cypherPath), { recursive: true })
    await writeFile(cypherPath, renderCypherImport(graph))
  }

  const result = {
    status: 'completed',
    graphPath: projectPath(outputPath),
    cypherPath: cypherPath ? projectPath(cypherPath) : undefined,
    summary: graph.summary,
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Wrote RedScope memory graph to ${projectPath(outputPath)}`)
  if (cypherPath) {
    console.log(`  cypher: ${projectPath(cypherPath)}`)
  }
  console.log(`  nodes: ${graph.summary.nodeCount}`)
  console.log(`  edges: ${graph.summary.edgeCount}`)
}

run(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(`redscope-memory-graph: ${error.message}`)
  process.exit(1)
})
