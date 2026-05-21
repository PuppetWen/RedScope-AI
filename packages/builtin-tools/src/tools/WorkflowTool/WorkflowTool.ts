import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join, parse } from 'path'
import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { truncate } from 'src/utils/format.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  WORKFLOW_DIR_NAME,
  WORKFLOW_DIR_NAMES,
  WORKFLOW_FILE_EXTENSIONS,
  WORKFLOW_RUN_DIR_NAMES,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_TOOL_NAME,
} from './constants.js'

const inputSchema = z.object({
  workflow: z.string().describe('Name of the workflow to execute'),
  args: z.string().optional().describe('Arguments to pass to the workflow'),
  action: z
    .enum(['start', 'status', 'advance', 'cancel', 'list'])
    .optional()
    .describe('Workflow action. Defaults to start.'),
  run_id: z
    .string()
    .optional()
    .describe('Workflow run id for status, advance, or cancel.'),
})
type Input = typeof inputSchema
type WorkflowInput = z.infer<Input>

type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'cancelled'

type WorkflowStep = {
  name: string
  prompt: string
  status: WorkflowStepStatus
  startedAt?: number
  completedAt?: number
}

type WorkflowRun = {
  runId: string
  workflow: string
  args?: string
  status: 'running' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number
  currentStepIndex: number
  steps: WorkflowStep[]
}

type WorkflowOutput = { output: string }

async function findWorkflowFile(
  cwd: string,
  workflow: string,
): Promise<{ path: string; content: string; dirName: string } | null> {
  for (const dirName of WORKFLOW_DIR_NAMES) {
    const workflowDir = join(cwd, dirName)
    for (const ext of WORKFLOW_FILE_EXTENSIONS) {
      const path = join(workflowDir, `${workflow}${ext}`)
      try {
        return { path, content: await readFile(path, 'utf-8'), dirName }
      } catch {
        // try next
      }
    }
  }
  return null
}

async function listAvailableWorkflows(cwd: string): Promise<string[]> {
  const seen = new Set<string>()
  for (const dirName of WORKFLOW_DIR_NAMES) {
    try {
      const files = await readdir(join(cwd, dirName))
      for (const file of files) {
        if (!WORKFLOW_FILE_EXTENSIONS.includes(parse(file).ext.toLowerCase())) {
          continue
        }
        seen.add(parse(file).name)
      }
    } catch {
      // try next dir
    }
  }
  return [...seen].sort()
}

function workflowRunPath(cwd: string, runId: string, dirName: string): string {
  return join(cwd, dirName, `${runId}.json`)
}

async function readWorkflowRun(
  cwd: string,
  runId: string,
): Promise<{ run: WorkflowRun; dirName: string } | null> {
  for (const dirName of WORKFLOW_RUN_DIR_NAMES) {
    try {
      const parsed = safeParseJSON(
        await readFile(workflowRunPath(cwd, runId, dirName), 'utf-8'),
        false,
      ) as Partial<WorkflowRun> | null
      if (
        !parsed ||
        typeof parsed.runId !== 'string' ||
        typeof parsed.workflow !== 'string' ||
        !Array.isArray(parsed.steps)
      ) {
        continue
      }
      return { run: parsed as WorkflowRun, dirName }
    } catch {
      // try next run dir
    }
  }
  return null
}

async function writeWorkflowRun(
  cwd: string,
  run: WorkflowRun,
  dirName = WORKFLOW_RUNS_DIR,
): Promise<void> {
  await mkdir(join(cwd, dirName), { recursive: true })
  await writeFile(
    workflowRunPath(cwd, run.runId, dirName),
    JSON.stringify(run, null, 2) + '\n',
    'utf-8',
  )
}

async function listWorkflowRuns(cwd: string): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = []
  const seen = new Set<string>()
  for (const dirName of WORKFLOW_RUN_DIR_NAMES) {
    let files: string[]
    try {
      files = await readdir(join(cwd, dirName))
    } catch {
      continue
    }
    const dirRuns = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(f => readWorkflowRun(cwd, f.slice(0, -'.json'.length))),
    )
    for (const result of dirRuns) {
      if (!result || seen.has(result.run.runId)) continue
      seen.add(result.run.runId)
      runs.push(result.run)
    }
  }
  return runs
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function parseMarkdownSteps(content: string): WorkflowStep[] {
  const steps: WorkflowStep[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const taskMatch = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/)
    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/)
    const text = taskMatch?.[1] ?? bulletMatch?.[1] ?? numberedMatch?.[1]
    if (!text) continue
    steps.push({ name: text.slice(0, 80), prompt: text, status: 'pending' })
  }
  return steps
}

function parseYamlSteps(content: string): WorkflowStep[] {
  const steps: WorkflowStep[] = []
  let current: Partial<WorkflowStep> | null = null
  const flush = () => {
    if (!current) return
    const prompt = current.prompt ?? current.name
    if (current.name && prompt) {
      steps.push({
        name: current.name,
        prompt,
        status: 'pending',
      })
    }
    current = null
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const stepText = line.match(/^-\s+(.+)$/)?.[1]
    if (stepText) {
      flush()
      const inlineName = stepText.match(/^name:\s*(.+)$/)?.[1]
      current = {
        name: inlineName ?? stepText,
        prompt: inlineName ? undefined : stepText,
      }
      continue
    }
    const name = line.match(/^name:\s*(.+)$/)?.[1]
    if (name) {
      if (!current) current = {}
      current.name = name
      continue
    }
    const prompt = line.match(/^(prompt|run|command):\s*(.+)$/)?.[2]
    if (prompt) {
      if (!current) current = {}
      current.prompt = prompt
    }
  }
  flush()
  return steps
}

function parseWorkflowSteps(filePath: string, content: string): WorkflowStep[] {
  const ext = parse(filePath).ext.toLowerCase()
  const steps =
    ext === '.md' ? parseMarkdownSteps(content) : parseYamlSteps(content)
  if (steps.length > 0) {
    return steps
  }
  return [
    {
      name: 'Execute workflow',
      prompt: content.trim(),
      status: 'pending',
    },
  ]
}

function formatStep(step: WorkflowStep, index: number): string {
  return `Step ${index + 1}: ${step.name}\n${step.prompt}`
}

function formatRunStatus(run: WorkflowRun): string {
  const lines = [
    `Workflow run: ${run.runId}`,
    `Workflow: ${run.workflow}`,
    `Status: ${run.status}`,
    `Current step: ${run.steps[run.currentStepIndex]?.name ?? 'none'}`,
    `Steps: ${run.steps.length}`,
  ]
  for (let i = 0; i < run.steps.length; i += 1) {
    const step = run.steps[i]!
    lines.push(`  ${i + 1}. [${step.status}] ${step.name}`)
  }
  return lines.join('\n')
}

async function startWorkflow(
  input: WorkflowInput,
  cwd: string,
): Promise<WorkflowOutput> {
  const found = await findWorkflowFile(cwd, input.workflow)
  if (!found) {
    const available = await listAvailableWorkflows(cwd)
    const hint =
      available.length > 0
        ? `\nAvailable workflows: ${available.join(', ')}`
        : `\nNo workflows found in ${WORKFLOW_DIR_NAMES.join(' or ')}. Create .md or .yaml files there.`
    return { output: `Error: Workflow "${input.workflow}" not found.${hint}` }
  }

  const steps = parseWorkflowSteps(found.path, found.content)
  const now = Date.now()
  steps[0] = { ...steps[0]!, status: 'running', startedAt: now }
  const run: WorkflowRun = {
    runId: randomUUID(),
    workflow: input.workflow,
    ...(input.args ? { args: input.args } : {}),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    currentStepIndex: 0,
    steps,
  }
  await writeWorkflowRun(cwd, run)

  const argsSection = input.args ? `\n\nArguments:\n${input.args}` : ''
  return {
    output: [
      `Workflow run started`,
      `run_id: ${run.runId}`,
      `workflow: ${run.workflow}`,
      '',
      formatStep(steps[0]!, 0),
      argsSection,
      '',
      `When this step is complete, call Workflow with action="advance" and run_id="${run.runId}".`,
    ].join('\n'),
  }
}

async function getRunOrError(
  cwd: string,
  runId: string | undefined,
): Promise<{ run?: WorkflowRun; dirName?: string; output?: string }> {
  if (!runId) return { output: 'Error: run_id is required for this action.' }
  const result = await readWorkflowRun(cwd, runId)
  if (!result) return { output: `Error: Workflow run "${runId}" not found.` }
  return result
}

async function advanceWorkflow(
  cwd: string,
  runId: string | undefined,
): Promise<WorkflowOutput> {
  const found = await getRunOrError(cwd, runId)
  if (!found.run) return { output: found.output! }
  const run = found.run
  const now = Date.now()
  const current = run.steps[run.currentStepIndex]
  if (current && current.status === 'running') {
    current.status = 'completed'
    current.completedAt = now
  }
  const nextIndex = run.currentStepIndex + 1
  if (nextIndex >= run.steps.length) {
    run.status = 'completed'
    run.updatedAt = now
    await writeWorkflowRun(cwd, run, found.dirName)
    return { output: `Workflow completed\nrun_id: ${run.runId}` }
  }
  run.currentStepIndex = nextIndex
  run.steps[nextIndex] = {
    ...run.steps[nextIndex]!,
    status: 'running',
    startedAt: now,
  }
  run.updatedAt = now
  await writeWorkflowRun(cwd, run, found.dirName)
  return {
    output: [
      `Next workflow step`,
      `run_id: ${run.runId}`,
      '',
      formatStep(run.steps[nextIndex]!, nextIndex),
      '',
      `When this step is complete, call Workflow with action="advance" and run_id="${run.runId}".`,
    ].join('\n'),
  }
}

async function cancelWorkflow(
  cwd: string,
  runId: string | undefined,
): Promise<WorkflowOutput> {
  const found = await getRunOrError(cwd, runId)
  if (!found.run) return { output: found.output! }
  const run = found.run
  const now = Date.now()
  run.status = 'cancelled'
  run.updatedAt = now
  for (const step of run.steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'cancelled'
    }
  }
  await writeWorkflowRun(cwd, run, found.dirName)
  return { output: `Workflow cancelled\nrun_id: ${run.runId}` }
}

async function listWorkflowRunsForOutput(cwd: string): Promise<WorkflowOutput> {
  const runs = await listWorkflowRuns(cwd)
  if (runs.length === 0) return { output: 'No workflow runs recorded.' }
  return {
    output: runs
      .slice(0, 20)
      .map(
        run =>
          `${run.runId} | ${run.workflow} | ${run.status} | step=${run.steps[run.currentStepIndex]?.name ?? 'none'} | updated=${new Date(run.updatedAt).toLocaleString()}`,
      )
      .join('\n'),
  }
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'execute user-defined workflow scripts',
  maxResultSizeChars: 50_000,
  strict: true,

  inputSchema,

  async description() {
    return 'Execute and track a user-defined workflow from .redscope/workflows/ or .claude/workflows/'
  },
  async prompt() {
    return `Use the Workflow tool to run user-defined workflows located in .redscope/workflows/ or .claude/workflows/. Workflows may be Markdown checklists/lists or YAML files with steps.

Actions:
- start (default): create a persisted workflow run and return the first step to execute
- advance: mark the current step complete and return the next step
- status: inspect a workflow run by run_id
- cancel: cancel a workflow run
- list: list recent workflow runs

Workflow run state is persisted in .redscope/workflow-runs/. Legacy .claude/workflow-runs/ state is still readable.`
  },
  userFacingName() {
    return 'Workflow'
  },
  isReadOnly(input) {
    return input.action === 'status' || input.action === 'list'
  },
  isEnabled() {
    return true
  },

  renderToolUseMessage(input: Partial<WorkflowInput>) {
    const name = input.workflow ?? 'unknown'
    const action = input.action ?? 'start'
    return input.args
      ? `Workflow: ${action} ${name} ${input.args}`
      : `Workflow: ${action} ${name}`
  },

  mapToolResultToToolResultBlockParam(
    content: WorkflowOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: truncate(content.output, 50_000),
    }
  },

  async call(input: WorkflowInput) {
    const cwd = process.cwd()
    const action = input.action ?? 'start'
    switch (action) {
      case 'start':
        return { data: await startWorkflow(input, cwd) }
      case 'status': {
        const found = await getRunOrError(cwd, input.run_id)
        return {
          data: {
            output: found.run ? formatRunStatus(found.run) : found.output!,
          },
        }
      }
      case 'advance':
        return { data: await advanceWorkflow(cwd, input.run_id) }
      case 'cancel':
        return { data: await cancelWorkflow(cwd, input.run_id) }
      case 'list':
        return { data: await listWorkflowRunsForOutput(cwd) }
    }
  },
})
