import { describe, expect, test } from 'bun:test'
import {
  judgeVerification,
  observationFromScannerHit,
  versionBannerObservation,
  DEFAULT_VERIFICATION_POLICY,
} from '../pocVerification'

describe('judgeVerification', () => {
  test('refuses to confirm on version/banner-only evidence', () => {
    const verdict = judgeVerification([
      versionBannerObservation('Apache/2.4.49'),
    ])
    expect(verdict.confirmed).toBe(false)
    expect(verdict.status).toBe('suspected')
    expect(verdict.weakVersionOnly).toBe(true)
    expect(verdict.reason).toMatch(/version\/banner/i)
  })

  test('confirms when a non-version probe matches with evidence', () => {
    const verdict = judgeVerification([
      {
        kind: 'http-body-regex',
        ok: true,
        matched: true,
        evidence: 'path traversal returned /etc/passwd root:x:0:0',
        confidence: 0.9,
      },
    ])
    expect(verdict.confirmed).toBe(true)
    expect(verdict.status).toBe('exploited') // strong evidence pattern
  })

  test('confirms as confirmed (not exploited) for weaker non-version match', () => {
    const verdict = judgeVerification([
      {
        kind: 'http-body-regex',
        ok: true,
        matched: true,
        evidence: 'unique error signature of CVE template matched',
        confidence: 0.8,
      },
    ])
    expect(verdict.confirmed).toBe(true)
    expect(verdict.status).toBe('confirmed')
  })

  test('stays suspected when nothing matched', () => {
    const verdict = judgeVerification([
      { kind: 'http-status', ok: true, matched: false },
    ])
    expect(verdict.confirmed).toBe(false)
    expect(verdict.matchedProbes).toBe(0)
  })

  test('honors minMatchedProbes policy', () => {
    const verdict = judgeVerification(
      [
        {
          kind: 'http-body-regex',
          ok: true,
          matched: true,
          evidence: 'marker-a present',
          confidence: 0.9,
        },
      ],
      { ...DEFAULT_VERIFICATION_POLICY, minMatchedProbes: 2 },
    )
    expect(verdict.confirmed).toBe(false)
    expect(verdict.reason).toMatch(/need ≥2/)
  })
})

describe('observationFromScannerHit', () => {
  test('maps a nuclei-like hit into a scanner-template observation', () => {
    const obs = observationFromScannerHit({
      templateId: 'CVE-2021-41773',
      evidence: 'file contents: root:x:0:0',
      matched: true,
    })
    expect(obs.kind).toBe('scanner-template')
    expect(obs.matched).toBe(true)
    expect(obs.templateId).toBe('CVE-2021-41773')
  })
})
