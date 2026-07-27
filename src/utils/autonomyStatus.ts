import { readdir } from 'fs/promises'
import { queryDaemonStatus } from '../daemon/state.js'
import { listLiveSessions } from '../cli/bg.js'
import {
  type AutonomyFlowRecord,
  formatAutonomyFlowsStatus,
} from './autonomyFlows.js'
import {
  type AutonomyRunRecord,
  formatAutonomyRunsStatus,
} from './autonomyRuns.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableReason,
} from './permissions/permissionSetup.js'
import { getUserConfigSubdirs } from './redscopeCompat.js'
import { cronToHuman } from './cron.js'
import { listAllCronTasks, nextCronRunMs } from './cronTasks.js'
import { getTeammateStatuses } from './teamDiscovery.js'
import { listTasks } from './tasks.js'
import {
  formatRemoteTriggerAuditStatus,
  listRemoteTriggerAuditRecords,
} from './remoteTriggerAudit.js'
import { formatWorkflowRunsStatus, listWorkflowRuns } from './workflowRuns.js'
import { formatPipeRegistryStatus } from './pipeStatus.js'
import { formatRemoteControlLocalStatus } from './remoteControlStatus.js'
import {
  formatEgressStatus,
  getEgressStatePath,
  loadEgressConfig,
  loadEgressRotationState,
  summarizeEgress,
} from './egressPool.js'
import {
  formatEngagementStatus,
  loadEngagementGraph,
  summarizeEngagement,
} from './engagementGraph.js'
import {
  formatPocCatalogStatus,
  loadPocCatalog,
  summarizePocCatalog,
} from './pocCatalog.js'
import {
  formatFirstRunStatus,
  loadFirstRunState,
} from './firstRunSetup.js'

type DeepStatusParams = {
  runs: AutonomyRunRecord[]
  flows: AutonomyFlowRecord[]
  nowMs?: number
}

export type AutonomyDeepStatusSectionId =
  | 'auto-mode'
  | 'first-run'
  | 'engagement'
  | 'egress'
  | 'poc'
  | 'runs'
  | 'flows'
  | 'cron'
  | 'workflow-runs'
  | 'teams'
  | 'pipes'
  | 'runtime'
  | 'remote-control'
  | 'remote-trigger'

export type AutonomyDeepStatusSection = {
  id: AutonomyDeepStatusSectionId
  title: string
  content: string
}

async function listTeamNames(): Promise<string[]> {
  const names = new Set<string>()
  for (const dir of getUserConfigSubdirs('teams')) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) names.add(entry.name)
      }
    } catch {
      // Skip missing or inaccessible compatibility dirs.
    }
  }
  return Array.from(names).sort()
}

async function formatTeamsSection(): Promise<string> {
  const teamNames = await listTeamNames()
  if (teamNames.length === 0) {
    return ['Teams: 0', '  none'].join('\n')
  }

  const lines = [`Teams: ${teamNames.length}`]
  for (const teamName of teamNames) {
    const teammates = getTeammateStatuses(teamName)
    const tasks = await listTasks(teamName)
    const openTasks = tasks.filter(t => t.status !== 'completed')
    const running = teammates.filter(t => t.status === 'running').length
    const idle = teammates.filter(t => t.status === 'idle').length
    lines.push(
      `  ${teamName}: teammates=${teammates.length} running=${running} idle=${idle} open_tasks=${openTasks.length}`,
    )
    for (const teammate of teammates.slice(0, 5)) {
      const ownerTasks = openTasks.filter(
        t => t.owner === teammate.name || t.owner === teammate.agentId,
      )
      lines.push(
        `    @${teammate.name}: ${teammate.status} backend=${teammate.backendType ?? 'unknown'} mode=${teammate.mode ?? 'default'} tasks=${ownerTasks.length}`,
      )
    }
    if (teammates.length > 5) {
      lines.push(`    ... ${teammates.length - 5} more teammate(s)`)
    }
  }
  return lines.join('\n')
}

async function formatCronSection(nowMs: number): Promise<string> {
  const jobs = await listAllCronTasks()
  if (jobs.length === 0) {
    return ['Cron jobs: 0', '  none'].join('\n')
  }
  const lines = [`Cron jobs: ${jobs.length}`]
  for (const job of jobs.slice(0, 10)) {
    const next = nextCronRunMs(job.cron, nowMs)
    lines.push(
      `  ${job.id}: ${cronToHuman(job.cron)} ${job.recurring ? 'recurring' : 'one-shot'} ${job.durable === false ? 'session-only' : 'durable'} next=${next ? new Date(next).toLocaleString() : 'none'}`,
    )
  }
  if (jobs.length > 10) {
    lines.push(`  ... ${jobs.length - 10} more job(s)`)
  }
  return lines.join('\n')
}

async function formatRuntimeSection(): Promise<string> {
  const daemon = queryDaemonStatus()
  const sessions = await listLiveSessions()
  const lines = [
    `Daemon: ${daemon.status}${daemon.state ? ` pid=${daemon.state.pid} workers=${daemon.state.workerKinds.join(',')}` : ''}`,
    `Background sessions: ${sessions.length}`,
  ]
  for (const session of sessions.slice(0, 8)) {
    lines.push(
      `  pid=${session.pid} kind=${session.kind} status=${session.status ?? 'unknown'} cwd=${session.cwd}`,
    )
  }
  if (sessions.length > 8) {
    lines.push(`  ... ${sessions.length - 8} more session(s)`)
  }
  return lines.join('\n')
}

export function formatAutoModeAvailability(
  gateEnabled: boolean,
  reason: string | null,
): string {
  const available = gateEnabled && reason === null
  return [
    `Auto mode: ${available ? 'available' : 'unavailable'}`,
    `  reason=${reason ?? (gateEnabled ? 'none' : 'gate-disabled')}`,
  ].join('\n')
}

function formatAutoModeSection(): string {
  let available = false
  let reason: string | null = null
  try {
    available = isAutoModeGateEnabled()
    reason = getAutoModeUnavailableReason()
  } catch (error) {
    return [
      'Auto mode: unknown',
      `  reason=${error instanceof Error ? error.message : String(error)}`,
    ].join('\n')
  }
  return formatAutoModeAvailability(available, reason)
}

function formatEngagementSection(): string {
  try {
    return formatEngagementStatus(summarizeEngagement(loadEngagementGraph()))
  } catch (error) {
    return `Engagement: unknown\n  reason=${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function formatEgressSection(nowMs: number): string {
  try {
    const config = loadEgressConfig()
    const state = loadEgressRotationState(getEgressStatePath(config))
    return formatEgressStatus(summarizeEgress({ config, state, nowMs }))
  } catch (error) {
    return `Egress pool: unknown\n  reason=${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function formatPocSection(): string {
  try {
    return formatPocCatalogStatus(summarizePocCatalog(loadPocCatalog()))
  } catch (error) {
    return `PoC references: unknown\n  reason=${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function formatFirstRunSection(): string {
  try {
    return formatFirstRunStatus(loadFirstRunState())
  } catch (error) {
    return `First-run: unknown\n  reason=${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

export async function formatAutonomyDeepStatusSections({
  runs,
  flows,
  nowMs = Date.now(),
}: DeepStatusParams): Promise<AutonomyDeepStatusSection[]> {
  return Promise.all([
    Promise.resolve({
      id: 'auto-mode' as const,
      title: 'Auto Mode',
      content: formatAutoModeSection(),
    }),
    Promise.resolve({
      id: 'first-run' as const,
      title: 'First Run',
      content: formatFirstRunSection(),
    }),
    Promise.resolve({
      id: 'engagement' as const,
      title: 'Engagement',
      content: formatEngagementSection(),
    }),
    Promise.resolve({
      id: 'egress' as const,
      title: 'Egress',
      content: formatEgressSection(nowMs),
    }),
    Promise.resolve({
      id: 'poc' as const,
      title: 'PoC References',
      content: formatPocSection(),
    }),
    Promise.resolve({
      id: 'runs' as const,
      title: 'Runs',
      content: formatAutonomyRunsStatus(runs),
    }),
    Promise.resolve({
      id: 'flows' as const,
      title: 'Flows',
      content: formatAutonomyFlowsStatus(flows),
    }),
    formatCronSection(nowMs).then(content => ({
      id: 'cron' as const,
      title: 'Cron',
      content,
    })),
    listWorkflowRuns().then(runs => ({
      id: 'workflow-runs' as const,
      title: 'Workflow Runs',
      content: formatWorkflowRunsStatus(runs),
    })),
    formatTeamsSection().then(content => ({
      id: 'teams' as const,
      title: 'Teams',
      content,
    })),
    formatPipeRegistryStatus().then(content => ({
      id: 'pipes' as const,
      title: 'Pipes',
      content,
    })),
    formatRuntimeSection().then(content => ({
      id: 'runtime' as const,
      title: 'Runtime',
      content,
    })),
    Promise.resolve({
      id: 'remote-control' as const,
      title: 'Remote Control',
      content: formatRemoteControlLocalStatus(),
    }),
    listRemoteTriggerAuditRecords().then(records => ({
      id: 'remote-trigger' as const,
      title: 'RemoteTrigger',
      content: formatRemoteTriggerAuditStatus(records),
    })),
  ])
}

export async function formatAutonomyDeepStatus(
  params: DeepStatusParams,
): Promise<string> {
  const sections = await formatAutonomyDeepStatusSections(params)
  return sections
    .map((section, index) =>
      [
        index === 0 ? '# Autonomy Deep Status' : `## ${section.title}`,
        section.content,
      ].join('\n'),
    )
    .join('\n\n')
}
