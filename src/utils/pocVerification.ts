/**
 * Evidence-based PoC verification.
 *
 * Goal: reduce false positives from "version banner ⇒ vulnerable".
 * A finding is only marked confirmed/exploited when the verifier returns
 * concrete evidence that meets the configured bar.
 *
 * This module deliberately does NOT ship weaponized exploit payloads. It
 * provides:
 *   - a pure decision function over structured probe results
 *   - safe, non-destructive probe kinds (http status/body/header checks,
 *     timing, auth-bypass indicators, file-read markers, callback tokens)
 *   - hooks so full-access autonomy can plug in external authorized scanners
 *     (nuclei templates, lab harnesses) and still go through the same
 *     evidence gate before writing to the engagement graph
 */

import type { FindingSeverity, FindingStatus } from './engagementGraph.js'
import type { PocReference } from './pocCatalog.js'
import { reportHostFinding, reportHostProgress } from './engagementProgress.js'

export type ProbeKind =
  | 'http-status'
  | 'http-body-regex'
  | 'http-header-regex'
  | 'http-timing'
  | 'auth-bypass'
  | 'file-read-marker'
  | 'out-of-band-token'
  | 'scanner-template' // external nuclei/etc result, already structured
  | 'manual'

export type ProbeObservation = {
  kind: ProbeKind
  /** Did the probe run successfully (transport-level)? */
  ok: boolean
  /** Did the probe's vulnerability condition match? */
  matched: boolean
  evidence?: string
  requestSummary?: string
  responseSummary?: string
  /** Elapsed ms for timing probes */
  elapsedMs?: number
  /** Confidence 0–1 from the probe itself */
  confidence?: number
  /** Optional raw scanner template id */
  templateId?: string
}

export type VerificationPolicy = {
  /** Minimum number of independent matched probes required. */
  minMatchedProbes: number
  /** Require at least one probe that is not a pure version/banner check. */
  requireNonVersionEvidence: boolean
  /** Minimum aggregate confidence (average of matched probes). */
  minConfidence: number
  /** Kinds that count as "version-only" and are insufficient alone. */
  versionOnlyKinds: ProbeKind[]
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  minMatchedProbes: 1,
  requireNonVersionEvidence: true,
  minConfidence: 0.6,
  // http-status alone on a version endpoint is treated as weak
  versionOnlyKinds: [],
}

export type VerificationVerdict = {
  status: FindingStatus
  confirmed: boolean
  reason: string
  matchedProbes: number
  evidence: string[]
  confidence: number
  weakVersionOnly: boolean
}

function isVersionBannerEvidence(obs: ProbeObservation): boolean {
  const text = `${obs.evidence ?? ''} ${obs.responseSummary ?? ''}`.toLowerCase()
  if (obs.kind === 'http-header-regex' && /server:|x-powered-by:/i.test(text)) {
    // Header product/version alone is version-banner tier.
    if (!obs.evidence || /vulnerable|exploited|uid=|root:|www-data|proof/i.test(obs.evidence) === false) {
      return true
    }
  }
  if (/only version|banner only|version detect|detected version/i.test(text)) {
    return true
  }
  return false
}

/**
 * Decide whether probe observations are enough to confirm a vulnerability.
 * Pure function — no IO.
 */
export function judgeVerification(
  observations: ProbeObservation[],
  policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY,
): VerificationVerdict {
  const matched = observations.filter(o => o.ok && o.matched)
  const evidence = matched
    .map(o => o.evidence)
    .filter((e): e is string => Boolean(e && e.trim()))

  if (matched.length === 0) {
    return {
      status: 'suspected',
      confirmed: false,
      reason: 'no probe matched — not confirming from absence of evidence',
      matchedProbes: 0,
      evidence: [],
      confidence: 0,
      weakVersionOnly: false,
    }
  }

  const versionOnly = matched.every(isVersionBannerEvidence)
  const confidence =
    matched.reduce((sum, o) => sum + (o.confidence ?? 0.7), 0) / matched.length

  if (
    policy.requireNonVersionEvidence &&
    versionOnly
  ) {
    return {
      status: 'suspected',
      confirmed: false,
      reason:
        'only version/banner evidence — refusing to confirm (high false-positive risk)',
      matchedProbes: matched.length,
      evidence,
      confidence,
      weakVersionOnly: true,
    }
  }

  if (matched.length < policy.minMatchedProbes) {
    return {
      status: 'suspected',
      confirmed: false,
      reason: `need ≥${policy.minMatchedProbes} matched probes, got ${matched.length}`,
      matchedProbes: matched.length,
      evidence,
      confidence,
      weakVersionOnly: versionOnly,
    }
  }

  if (confidence < policy.minConfidence) {
    return {
      status: 'suspected',
      confirmed: false,
      reason: `aggregate confidence ${confidence.toFixed(2)} < required ${policy.minConfidence}`,
      matchedProbes: matched.length,
      evidence,
      confidence,
      weakVersionOnly: versionOnly,
    }
  }

  // Strong evidence patterns escalate to exploited
  const strong = evidence.some(e =>
    /uid=\d+|root:|www-data|proof-of-concept|callback received|file contents:|wrote webshell|authentication bypassed/i.test(
      e,
    ),
  )

  return {
    status: strong ? 'exploited' : 'confirmed',
    confirmed: true,
    reason: strong
      ? 'matched probes with strong exploitation evidence'
      : 'matched probes with non-version evidence',
    matchedProbes: matched.length,
    evidence,
    confidence,
    weakVersionOnly: false,
  }
}

export type VerifyAndRecordParams = {
  hostId: string
  poc: Pick<PocReference, 'id' | 'title' | 'severity' | 'product'>
  observations: ProbeObservation[]
  policy?: VerificationPolicy
  port?: number
  service?: string
  /** Progress to write on the host after judging. */
  progress?: number
  activity?: string
  /** When false, do not write suspected (version-only) findings at all. */
  recordSuspected?: boolean
}

/**
 * Judge observations and, if warranted, write a finding + progress onto the
 * engagement graph. Returns the verdict so callers can branch.
 */
export function verifyAndRecordFinding(
  params: VerifyAndRecordParams,
): VerificationVerdict {
  const verdict = judgeVerification(
    params.observations,
    params.policy ?? DEFAULT_VERIFICATION_POLICY,
  )

  if (!verdict.confirmed && params.recordSuspected === false) {
    if (params.progress !== undefined) {
      reportHostProgress({
        hostId: params.hostId,
        progress: params.progress,
        activity: params.activity ?? `checked ${params.poc.id} (not confirmed)`,
        status: 'testing',
      })
    }
    return verdict
  }

  const evidenceText = [
    ...verdict.evidence,
    `verdict: ${verdict.reason}`,
    `confidence: ${verdict.confidence.toFixed(2)}`,
    `matchedProbes: ${verdict.matchedProbes}`,
  ].join(' | ')

  reportHostFinding({
    hostId: params.hostId,
    title: params.poc.title,
    severity: (params.poc.severity === 'unknown'
      ? 'info'
      : params.poc.severity) as FindingSeverity,
    status: verdict.status,
    cve: params.poc.id.startsWith('CVE-') ? params.poc.id : undefined,
    port: params.port,
    service: params.service ?? params.poc.product,
    evidence: evidenceText,
    progress: params.progress,
    activity:
      params.activity ??
      (verdict.confirmed
        ? `verified ${params.poc.id}`
        : `probed ${params.poc.id} (suspected only)`),
  })

  return verdict
}

/**
 * Helper for external scanner (e.g. nuclei JSONL) lines → ProbeObservation.
 * Accepts already-parsed objects; no exploit logic here.
 */
export function observationFromScannerHit(hit: {
  matched?: boolean
  templateId?: string
  evidence?: string
  request?: string
  response?: string
  confidence?: number
}): ProbeObservation {
  return {
    kind: 'scanner-template',
    ok: true,
    matched: hit.matched !== false,
    evidence: hit.evidence,
    requestSummary: hit.request,
    responseSummary: hit.response,
    confidence: hit.confidence ?? 0.8,
    templateId: hit.templateId,
  }
}

/**
 * Build a deliberately-weak version-only observation (for tests / demos of the
 * false-positive guard).
 */
export function versionBannerObservation(banner: string): ProbeObservation {
  return {
    kind: 'http-header-regex',
    ok: true,
    matched: true,
    evidence: `banner only: Server: ${banner}`,
    responseSummary: `Server: ${banner}`,
    confidence: 0.4,
  }
}
