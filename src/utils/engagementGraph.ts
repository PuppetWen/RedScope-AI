/**
 * Engagement graph — the live map of an authorized penetration test.
 *
 * Tracks which targets are under test, what has been found on each, and — for
 * internal-network work — how hosts relate to one another (pivots, trusts,
 * routes) so the recon dashboard can draw a network graph and let the operator
 * click a host to see its discovered vulnerabilities.
 *
 * Pure + serializable so it can be unit-tested and persisted to
 * `redscope-engagement.json` in the workspace. Recording a finding here does not
 * exploit anything; it is an evidence/notes model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getCwd } from './cwd.js'

export const ENGAGEMENT_FILENAME = 'redscope-engagement.json'

export type HostZone = 'external' | 'dmz' | 'internal'
export type HostKind = 'host' | 'network-device'
export type NetworkDeviceType =
  | 'firewall'
  | 'router'
  | 'switch'
  | 'waf'
  | 'load-balancer'
  | 'vpn'
  | 'proxy'
  | 'other'
export type HostStatus =
  | 'queued'
  | 'scanning'
  | 'testing'
  | 'compromised'
  | 'clean'
  | 'idle'
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type FindingStatus =
  | 'suspected'
  | 'confirmed'
  | 'exploited'
  | 'remediated'
export type EdgeKind =
  | 'pivot'
  | 'trust'
  | 'route'
  | 'scan'
  | 'lateral'
  | 'transit'
  | 'management'

const HOST_ZONES: readonly HostZone[] = ['external', 'dmz', 'internal']
const HOST_KINDS: readonly HostKind[] = ['host', 'network-device']
const DEVICE_TYPES: readonly NetworkDeviceType[] = [
  'firewall',
  'router',
  'switch',
  'waf',
  'load-balancer',
  'vpn',
  'proxy',
  'other',
]
const HOST_STATUSES: readonly HostStatus[] = [
  'queued',
  'scanning',
  'testing',
  'compromised',
  'clean',
  'idle',
]
const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
]
const FINDING_STATUSES: readonly FindingStatus[] = [
  'suspected',
  'confirmed',
  'exploited',
  'remediated',
]
const EDGE_KINDS: readonly EdgeKind[] = [
  'pivot',
  'trust',
  'route',
  'scan',
  'lateral',
  'transit',
  'management',
]

export type EngagementFinding = {
  id: string
  title: string
  severity: FindingSeverity
  status: FindingStatus
  cve?: string
  port?: number
  service?: string
  evidence?: string
  addedAt?: string
}

export type EngagementHost = {
  id: string
  label: string
  ip?: string
  hostname?: string
  zone: HostZone
  kind: HostKind
  deviceType?: NetworkDeviceType
  status: HostStatus
  /** 0–100 engagement progress for this node (scanning/testing work). */
  progress: number
  /** Short operator-facing activity string, e.g. "SMB enum". */
  activity?: string
  os?: string
  role?: string
  vendor?: string
  tags: string[]
  findings: EngagementFinding[]
}

export type EngagementEdge = {
  from: string
  to: string
  kind: EdgeKind
  label?: string
  /** Optional intermediate network device this path traverses. */
  via?: string
}

export type EngagementScope = {
  authorizedTargets?: string[]
  reference?: string
}

export type EngagementGraph = {
  schemaVersion: number
  name?: string
  updatedAt?: string
  scope?: EngagementScope
  hosts: EngagementHost[]
  edges: EngagementEdge[]
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFinding(
  raw: unknown,
  index: number,
): EngagementFinding | null {
  const f = (raw ?? {}) as Record<string, unknown>
  if (typeof f.title !== 'string') return null
  return {
    id: typeof f.id === 'string' ? f.id : `finding-${index + 1}`,
    title: f.title,
    severity: oneOf(f.severity, FINDING_SEVERITIES, 'info'),
    status: oneOf(f.status, FINDING_STATUSES, 'suspected'),
    cve: str(f.cve),
    port:
      typeof f.port === 'number' && Number.isInteger(f.port)
        ? f.port
        : undefined,
    service: str(f.service),
    evidence: str(f.evidence),
    addedAt: str(f.addedAt),
  }
}

function clampProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizeHost(raw: unknown): EngagementHost | null {
  const h = (raw ?? {}) as Record<string, unknown>
  if (typeof h.id !== 'string') return null
  const findings = Array.isArray(h.findings)
    ? h.findings
        .map((item, i) => normalizeFinding(item, i))
        .filter((f): f is EngagementFinding => f !== null)
    : []
  const tags = Array.isArray(h.tags)
    ? h.tags.filter((t): t is string => typeof t === 'string')
    : []
  const kind = oneOf(h.kind, HOST_KINDS, 'host')
  const deviceType =
    kind === 'network-device'
      ? oneOf(h.deviceType, DEVICE_TYPES, 'other')
      : h.deviceType
        ? oneOf(h.deviceType, DEVICE_TYPES, 'other')
        : undefined
  return {
    id: h.id,
    label: typeof h.label === 'string' ? h.label : h.id,
    ip: str(h.ip),
    hostname: str(h.hostname),
    zone: oneOf(h.zone, HOST_ZONES, 'external'),
    kind,
    deviceType,
    status: oneOf(h.status, HOST_STATUSES, 'queued'),
    progress: clampProgress(h.progress),
    activity: str(h.activity),
    os: str(h.os),
    role: str(h.role),
    vendor: str(h.vendor),
    tags,
    findings,
  }
}

/**
 * Validate + normalize a raw graph. Hosts without ids and edges that reference
 * unknown hosts are dropped, so the dashboard never renders a dangling edge.
 */
export function normalizeEngagementGraph(raw: unknown): EngagementGraph {
  const r = (raw ?? {}) as Record<string, unknown>
  const hosts: EngagementHost[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.hosts)) {
    for (const item of r.hosts) {
      const host = normalizeHost(item)
      if (!host || seen.has(host.id)) continue
      seen.add(host.id)
      hosts.push(host)
    }
  }
  const edges: EngagementEdge[] = []
  if (Array.isArray(r.edges)) {
    for (const item of r.edges) {
      const e = (item ?? {}) as Record<string, unknown>
      if (typeof e.from !== 'string' || typeof e.to !== 'string') continue
      if (!seen.has(e.from) || !seen.has(e.to)) continue
      const via = str(e.via)
      edges.push({
        from: e.from,
        to: e.to,
        kind: oneOf(e.kind, EDGE_KINDS, 'route'),
        label: str(e.label),
        via: via && seen.has(via) ? via : undefined,
      })
    }
  }
  const scope = (r.scope ?? undefined) as Record<string, unknown> | undefined
  return {
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : 1,
    name: str(r.name),
    updatedAt: str(r.updatedAt),
    scope: scope
      ? {
          authorizedTargets: Array.isArray(scope.authorizedTargets)
            ? scope.authorizedTargets.filter(
                (t): t is string => typeof t === 'string',
              )
            : undefined,
          reference: str(scope.reference),
        }
      : undefined,
    hosts,
    edges,
  }
}

export function createEngagementGraph(name?: string): EngagementGraph {
  return { schemaVersion: 1, name, hosts: [], edges: [] }
}

// --- mutators (return a new graph; callers persist the result) --------------

export function upsertHost(
  graph: EngagementGraph,
  host: Partial<EngagementHost> & { id: string },
): EngagementGraph {
  const existing = graph.hosts.find(h => h.id === host.id)
  const kind = host.kind ?? existing?.kind ?? 'host'
  const merged: EngagementHost = {
    id: host.id,
    label: host.label ?? existing?.label ?? host.id,
    ip: host.ip ?? existing?.ip,
    hostname: host.hostname ?? existing?.hostname,
    zone: host.zone ?? existing?.zone ?? 'external',
    kind,
    deviceType:
      host.deviceType ??
      existing?.deviceType ??
      (kind === 'network-device' ? 'other' : undefined),
    status: host.status ?? existing?.status ?? 'queued',
    progress:
      host.progress !== undefined
        ? clampProgress(host.progress)
        : (existing?.progress ?? 0),
    activity: host.activity ?? existing?.activity,
    os: host.os ?? existing?.os,
    role: host.role ?? existing?.role,
    vendor: host.vendor ?? existing?.vendor,
    tags: host.tags ?? existing?.tags ?? [],
    findings: host.findings ?? existing?.findings ?? [],
  }
  const hosts = existing
    ? graph.hosts.map(h => (h.id === host.id ? merged : h))
    : [...graph.hosts, merged]
  return { ...graph, hosts }
}

/** Update progress/activity on an existing host; no-op if host is missing. */
export function setHostProgress(
  graph: EngagementGraph,
  hostId: string,
  progress: number,
  activity?: string,
  status?: HostStatus,
): EngagementGraph {
  const host = graph.hosts.find(h => h.id === hostId)
  if (!host) return graph
  return upsertHost(graph, {
    id: hostId,
    progress,
    activity: activity ?? host.activity,
    status: status ?? host.status,
  })
}

export function addFinding(
  graph: EngagementGraph,
  hostId: string,
  finding: Omit<EngagementFinding, 'id'> & { id?: string },
): EngagementGraph {
  const host = graph.hosts.find(h => h.id === hostId)
  if (!host) return graph
  const id = finding.id ?? `${hostId}-f${host.findings.length + 1}`
  const nextFinding: EngagementFinding = { ...finding, id }
  const updated: EngagementHost = {
    ...host,
    findings: [...host.findings, nextFinding],
  }
  return {
    ...graph,
    hosts: graph.hosts.map(h => (h.id === hostId ? updated : h)),
  }
}

export function upsertEdge(
  graph: EngagementGraph,
  edge: EngagementEdge,
): EngagementGraph {
  const known = new Set(graph.hosts.map(h => h.id))
  if (!known.has(edge.from) || !known.has(edge.to)) return graph
  const idx = graph.edges.findIndex(
    e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
  )
  if (idx >= 0) {
    const edges = graph.edges.slice()
    edges[idx] = edge
    return { ...graph, edges }
  }
  return { ...graph, edges: [...graph.edges, edge] }
}

// --- summary ----------------------------------------------------------------

export type EngagementSummary = {
  present: boolean
  hosts: number
  devices: number
  byZone: Record<HostZone, number>
  byStatus: Record<HostStatus, number>
  findings: number
  bySeverity: Record<FindingSeverity, number>
  exploited: number
  edges: number
  activeTargets: string[]
  avgProgress: number
}

export function summarizeEngagement(
  graph: EngagementGraph | null,
): EngagementSummary {
  const byZone: Record<HostZone, number> = {
    external: 0,
    dmz: 0,
    internal: 0,
  }
  const byStatus: Record<HostStatus, number> = {
    queued: 0,
    scanning: 0,
    testing: 0,
    compromised: 0,
    clean: 0,
    idle: 0,
  }
  const bySeverity: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }
  if (!graph || graph.hosts.length === 0) {
    return {
      present: false,
      hosts: 0,
      devices: 0,
      byZone,
      byStatus,
      findings: 0,
      bySeverity,
      exploited: 0,
      edges: graph?.edges.length ?? 0,
      activeTargets: [],
      avgProgress: 0,
    }
  }
  let findings = 0
  let exploited = 0
  let devices = 0
  let progressSum = 0
  const activeTargets: string[] = []
  for (const host of graph.hosts) {
    byZone[host.zone] += 1
    byStatus[host.status] += 1
    progressSum += host.progress
    if (host.kind === 'network-device') devices += 1
    if (host.status === 'scanning' || host.status === 'testing') {
      activeTargets.push(
        host.progress > 0 ? `${host.label} ${host.progress}%` : host.label,
      )
    }
    for (const finding of host.findings) {
      findings += 1
      bySeverity[finding.severity] += 1
      if (finding.status === 'exploited') exploited += 1
    }
  }
  return {
    present: true,
    hosts: graph.hosts.length,
    devices,
    byZone,
    byStatus,
    findings,
    bySeverity,
    exploited,
    edges: graph.edges.length,
    activeTargets,
    avgProgress: Math.round(progressSum / graph.hosts.length),
  }
}

export function formatEngagementStatus(summary: EngagementSummary): string {
  if (!summary.present) {
    return [
      'Engagement: no hosts mapped',
      `  create ${ENGAGEMENT_FILENAME} (or record a target) to start the recon map`,
    ].join('\n')
  }
  const sev = summary.bySeverity
  const active =
    summary.activeTargets.length > 0
      ? summary.activeTargets.slice(0, 4).join(', ') +
        (summary.activeTargets.length > 4
          ? ` +${summary.activeTargets.length - 4}`
          : '')
      : 'none'
  return [
    `Engagement: ${summary.hosts} nodes (${summary.devices} net-dev) ext=${summary.byZone.external} dmz=${summary.byZone.dmz} int=${summary.byZone.internal} · ${summary.edges} links · avg ${summary.avgProgress}%`,
    `  under test: ${active}`,
    `  findings: ${summary.findings} (crit=${sev.critical} high=${sev.high} med=${sev.medium}) exploited=${summary.exploited}`,
  ].join('\n')
}

// --- IO ---------------------------------------------------------------------

export function getEngagementPath(): string {
  return join(getCwd(), ENGAGEMENT_FILENAME)
}

export function loadEngagementGraph(): EngagementGraph | null {
  const path = getEngagementPath()
  if (!existsSync(path)) return null
  try {
    return normalizeEngagementGraph(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}

export function saveEngagementGraph(
  graph: EngagementGraph,
  nowIso?: string,
): void {
  const path = getEngagementPath()
  mkdirSync(dirname(path), { recursive: true })
  const payload: EngagementGraph = {
    ...graph,
    updatedAt: nowIso ?? graph.updatedAt,
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}
