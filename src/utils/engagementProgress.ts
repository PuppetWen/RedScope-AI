/**
 * Auto-write engagement progress during active testing.
 *
 * Call sites (profile steps, autonomous loops, manual tool steps) should use
 * `reportHostProgress` / `beginHostTest` / `completeHostTest` so the live recon
 * map and HUD always reflect which machine is under test and how far along it is.
 */

import {
  addFinding,
  type EngagementFinding,
  type EngagementGraph,
  type FindingSeverity,
  type FindingStatus,
  type HostStatus,
  loadEngagementGraph,
  saveEngagementGraph,
  setHostProgress,
  upsertHost,
} from './engagementGraph.js'
import { invalidateRedscopeStatusCache } from './redscopeStatus.js'
import { renderEngagementDashboardHtml } from './engagementDashboard.js'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from './cwd.js'

export type ProgressReport = {
  hostId: string
  /** 0–100 */
  progress: number
  activity?: string
  status?: HostStatus
  label?: string
  ip?: string
  hostname?: string
  zone?: 'external' | 'dmz' | 'internal'
  role?: string
  /** When true, also regenerate redscope-recon-map.html next to the engagement. */
  refreshMap?: boolean
}

function ensureGraph(): EngagementGraph {
  return (
    loadEngagementGraph() ?? {
      schemaVersion: 1,
      name: 'Live Engagement',
      hosts: [],
      edges: [],
    }
  )
}

function persist(
  graph: EngagementGraph,
  refreshMap: boolean,
): EngagementGraph {
  const nowIso = new Date().toISOString()
  const next = { ...graph, updatedAt: nowIso }
  saveEngagementGraph(next, nowIso)
  invalidateRedscopeStatusCache()
  if (refreshMap) {
    try {
      const html = renderEngagementDashboardHtml(next, {
        generatedAt: nowIso.slice(0, 19).replace('T', ' '),
      })
      writeFileSync(join(getCwd(), 'redscope-recon-map.html'), html, 'utf-8')
    } catch {
      // Map regeneration is best-effort; progress itself already persisted.
    }
  }
  return next
}

/**
 * Upsert a host (creating it if missing) and write progress/activity/status.
 * Always persists to `redscope-engagement.json`.
 */
export function reportHostProgress(report: ProgressReport): EngagementGraph {
  let graph = ensureGraph()
  const existing = graph.hosts.find(h => h.id === report.hostId)
  if (!existing) {
    graph = upsertHost(graph, {
      id: report.hostId,
      label: report.label ?? report.hostId,
      ip: report.ip,
      hostname: report.hostname,
      zone: report.zone ?? 'external',
      role: report.role,
      status: report.status ?? 'testing',
      progress: report.progress,
      activity: report.activity,
    })
  } else {
    graph = setHostProgress(
      graph,
      report.hostId,
      report.progress,
      report.activity,
      report.status,
    )
    if (
      report.label ||
      report.ip ||
      report.hostname ||
      report.zone ||
      report.role
    ) {
      graph = upsertHost(graph, {
        id: report.hostId,
        label: report.label,
        ip: report.ip,
        hostname: report.hostname,
        zone: report.zone,
        role: report.role,
      })
    }
  }
  return persist(graph, report.refreshMap !== false)
}

/** Mark a host as actively under test at 0% (or a supplied starting progress). */
export function beginHostTest(params: {
  hostId: string
  label?: string
  ip?: string
  activity?: string
  zone?: 'external' | 'dmz' | 'internal'
  startingProgress?: number
}): EngagementGraph {
  return reportHostProgress({
    hostId: params.hostId,
    label: params.label,
    ip: params.ip,
    zone: params.zone,
    progress: params.startingProgress ?? 0,
    activity: params.activity ?? 'starting tests',
    status: 'testing',
  })
}

/** Mark a host complete (100%) with a terminal status. */
export function completeHostTest(params: {
  hostId: string
  status?: 'compromised' | 'clean' | 'queued'
  activity?: string
}): EngagementGraph {
  return reportHostProgress({
    hostId: params.hostId,
    progress: 100,
    activity: params.activity ?? 'tests complete',
    status: params.status ?? 'clean',
  })
}

/** Record a finding on a host and bump progress if still mid-test. */
export function reportHostFinding(params: {
  hostId: string
  title: string
  severity: FindingSeverity
  status?: FindingStatus
  cve?: string
  port?: number
  service?: string
  evidence?: string
  /** Optional absolute progress to set after recording the finding. */
  progress?: number
  activity?: string
}): EngagementGraph {
  let graph = ensureGraph()
  if (!graph.hosts.some(h => h.id === params.hostId)) {
    graph = upsertHost(graph, {
      id: params.hostId,
      status: 'testing',
      progress: params.progress ?? 10,
    })
  }
  const finding: Omit<EngagementFinding, 'id'> & { id?: string } = {
    title: params.title,
    severity: params.severity,
    status: params.status ?? 'confirmed',
    cve: params.cve,
    port: params.port,
    service: params.service,
    evidence: params.evidence,
    addedAt: new Date().toISOString(),
  }
  graph = addFinding(graph, params.hostId, finding)
  if (params.progress !== undefined || params.activity) {
    const host = graph.hosts.find(h => h.id === params.hostId)
    graph = setHostProgress(
      graph,
      params.hostId,
      params.progress ?? host?.progress ?? 0,
      params.activity ?? host?.activity,
      host?.status === 'queued' ? 'testing' : host?.status,
    )
  }
  return persist(graph, true)
}

/** Convenience: does the workspace already have an engagement file? */
export function hasEngagementFile(): boolean {
  return existsSync(join(getCwd(), 'redscope-engagement.json'))
}
