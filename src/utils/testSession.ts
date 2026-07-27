/**
 * High-level "during a pentest step" helper that combines:
 *   - silent egress health-check + auto-rotate
 *   - engagement progress auto-write
 *   - HTTP fingerprint → n-day / PoC catalog capture
 *
 * Profile runners and autonomy loops should prefer this over calling the
 * lower-level pieces separately.
 */

import {
  endSilentEgress,
  ensureWorkingSilentEgress,
  fetchWithSilentEgress,
  type SilentEgressSession,
} from './silentEgress.js'
import {
  beginHostTest,
  completeHostTest,
  reportHostProgress,
} from './engagementProgress.js'
import { fingerprintHttpResponse } from './techFingerprint.js'
import { captureNdaysForFingerprint } from './ndayCapture.js'
import {
  detectNuclei,
  runNucleiForHost,
  type NucleiPrompt,
  type NucleiRunResult,
} from './nucleiTool.js'
import {
  verifyAndRecordFinding,
  type VerificationVerdict,
} from './pocVerification.js'

export type TestStepContext = {
  hostId: string
  label?: string
  ip?: string
  url?: string
  zone?: 'external' | 'dmz' | 'internal'
  session: SilentEgressSession
}

export type StartTestStepOptions = {
  hostId: string
  label?: string
  ip?: string
  url?: string
  zone?: 'external' | 'dmz' | 'internal'
  activity?: string
  /** Skip arming silent egress (e.g. lab with direct routing). */
  skipEgress?: boolean
}

/**
 * Begin testing a host: write 0% progress, arm silent egress (health-check +
 * pick a live proxy), return a context used by later helpers.
 */
export async function startTestStep(
  options: StartTestStepOptions,
): Promise<TestStepContext> {
  beginHostTest({
    hostId: options.hostId,
    label: options.label,
    ip: options.ip ?? options.url,
    zone: options.zone,
    activity: options.activity ?? 'starting tests · arming egress',
  })

  let session: SilentEgressSession
  if (options.skipEgress) {
    session = {
      enabled: false,
      config: null,
      state: {
        switchesThisStep: 0,
        nodes: {},
      },
      statePath: '',
      activeNode: null,
      switches: 0,
      maxSwitches: 0,
      events: [],
      originalProxyEnv: {},
    }
  } else {
    session = await ensureWorkingSilentEgress({
      target: options.url ?? options.ip ?? options.hostId,
    })
    const egressNote = session.activeNode
      ? `egress ${session.activeNode.sourceIp ?? session.activeNode.host}`
      : 'direct (no live proxy)'
    reportHostProgress({
      hostId: options.hostId,
      progress: 5,
      activity: `armed · ${egressNote}`,
      status: 'testing',
      refreshMap: true,
    })
  }

  return {
    hostId: options.hostId,
    label: options.label,
    ip: options.ip,
    url: options.url,
    zone: options.zone,
    session,
  }
}

export type ProbeAndCaptureOptions = {
  /** Override URL (defaults to ctx.url). */
  url?: string
  /** Progress to set after fingerprint (default 30). */
  progress?: number
  /** Query NVD online for new ndays (default true). */
  onlineNday?: boolean
  init?: RequestInit
}

/**
 * Fetch a target through silent egress, fingerprint it, capture matching /
 * new n-day PoC refs into the local catalog, and bump engagement progress.
 */
export async function probeFingerprintAndCaptureNdays(
  ctx: TestStepContext,
  options: ProbeAndCaptureOptions = {},
): Promise<{
  products: string[]
  ndayHits: number
  newlyAdded: number
  statusCode?: number
  session: SilentEgressSession
}> {
  const url = options.url ?? ctx.url
  if (!url) {
    throw new Error('probeFingerprintAndCaptureNdays: url required')
  }

  reportHostProgress({
    hostId: ctx.hostId,
    progress: Math.min(15, options.progress ?? 30),
    activity: `fetch ${url}`,
    status: 'scanning',
  })

  const { response, session } = await fetchWithSilentEgress(
    url,
    {
      redirect: 'follow',
      headers: {
        'User-Agent': 'RedScopeAI-TestSession/1.0',
        ...(options.init?.headers as Record<string, string> | undefined),
      },
      ...options.init,
    },
    { session: ctx.session, target: url },
  )
  ctx.session = session

  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    headers[k] = v
  })
  const body = await response.text()
  const fp = fingerprintHttpResponse({
    url,
    finalUrl: response.url,
    statusCode: response.status,
    headers,
    body: body.slice(0, 200_000),
  })

  reportHostProgress({
    hostId: ctx.hostId,
    progress: options.progress ?? 30,
    activity:
      fp.products.length > 0
        ? `fingerprint: ${fp.products.slice(0, 3).join(', ')}`
        : 'fingerprint: (no product)',
    status: 'testing',
  })

  let ndayHits = 0
  let newlyAdded = 0
  if (fp.products.length > 0) {
    const captured = await captureNdaysForFingerprint(fp, {
      online: options.onlineNday !== false,
    })
    ndayHits = captured.hits.length
    newlyAdded = captured.newlyAdded
    reportHostProgress({
      hostId: ctx.hostId,
      progress: Math.max(options.progress ?? 30, 40),
      activity: `nday: ${ndayHits} hit(s) (+${newlyAdded} saved)`,
      status: 'testing',
    })
  }

  return {
    products: fp.products,
    ndayHits,
    newlyAdded,
    statusCode: response.status,
    session,
  }
}

/** Finish a test step: optional terminal status + disarm silent egress. */
export function finishTestStep(
  ctx: TestStepContext,
  options?: {
    status?: 'compromised' | 'clean' | 'queued'
    activity?: string
  },
): void {
  completeHostTest({
    hostId: ctx.hostId,
    status: options?.status ?? 'clean',
    activity: options?.activity ?? 'step complete',
  })
  endSilentEgress(ctx.session)
}

export type NucleiStepResult = {
  ran: boolean
  prompt?: NucleiPrompt
  result?: NucleiRunResult
  verdicts: VerificationVerdict[]
}

/**
 * If nuclei is installed, run it against the step URL/host and record only
 * evidence-gated findings. If missing, return a prompt the UI/CLI should show
 * so the operator can `bun run redscope:nuclei-setup` (downloads into tools/bin).
 *
 * Set `autoInstall: true` only when the operator already consented (e.g. full
 * access + explicit yes) — otherwise we only prompt.
 */
export async function maybeRunNucleiVerification(
  ctx: TestStepContext,
  options?: {
    autoInstall?: boolean
    severity?: string
    templates?: string
    onPrompt?: (prompt: NucleiPrompt) => void
  },
): Promise<NucleiStepResult> {
  const target = ctx.url ?? ctx.ip
  if (!target) {
    return { ran: false, verdicts: [] }
  }

  const presence = detectNuclei()
  if (!presence.available && !options?.autoInstall) {
    const { buildNucleiMissingPrompt } = await import('./nucleiTool.js')
    const prompt = buildNucleiMissingPrompt()
    options?.onPrompt?.(prompt)
    reportHostProgress({
      hostId: ctx.hostId,
      progress: 45,
      activity: 'nuclei missing — awaiting install into tools/bin',
      status: 'testing',
    })
    return { ran: false, prompt, verdicts: [] }
  }

  const result = await runNucleiForHost({
    hostId: ctx.hostId,
    targets: [target],
    autoInstall: options?.autoInstall,
    severity: options?.severity,
    templates: options?.templates,
    onPrompt: options?.onPrompt,
  })

  if (result.prompt && !result.ok) {
    options?.onPrompt?.(result.prompt)
    return { ran: false, prompt: result.prompt, result, verdicts: [] }
  }

  const verdicts: VerificationVerdict[] = []
  for (const hit of result.hits) {
    const obs = result.observations.filter(
      o => o.templateId === hit.templateId || !hit.templateId,
    )
    const related =
      obs.length > 0
        ? obs
        : result.observations.slice(0, 1)
    const verdict = verifyAndRecordFinding({
      hostId: ctx.hostId,
      poc: {
        id: hit.templateId ?? hit.name ?? 'nuclei-hit',
        title: hit.name ?? hit.templateId ?? 'Nuclei template match',
        severity: (['critical', 'high', 'medium', 'low'].includes(
          (hit.severity ?? '').toLowerCase(),
        )
          ? (hit.severity as 'critical' | 'high' | 'medium' | 'low')
          : 'medium'),
        product: undefined,
      },
      observations: related.length
        ? related
        : [
            {
              kind: 'scanner-template',
              ok: true,
              matched: true,
              evidence: hit.evidence ?? hit.matchedAt,
              templateId: hit.templateId,
              confidence: 0.7,
            },
          ],
      progress: 75,
      activity: `nuclei ${hit.templateId ?? hit.name ?? 'hit'}`,
      // version-only / info noise stays out of the graph unless evidence-rich
      recordSuspected: false,
    })
    verdicts.push(verdict)
  }

  return { ran: true, result, verdicts }
}
