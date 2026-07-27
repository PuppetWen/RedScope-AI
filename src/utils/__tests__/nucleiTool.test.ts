import { describe, expect, test } from 'bun:test'
import {
  buildNucleiMissingPrompt,
  detectNuclei,
  formatNucleiStatus,
  hitsToObservations,
  type NucleiHit,
} from '../nucleiTool'
import { judgeVerification } from '../pocVerification'

describe('detectNuclei / prompt', () => {
  test('returns a structured presence object', () => {
    const p = detectNuclei()
    expect(typeof p.available).toBe('boolean')
    expect(['path', 'tools-bin', 'workspace', 'missing']).toContain(p.source)
  })

  test('missing prompt points at tools/bin and nuclei-setup', () => {
    const prompt = buildNucleiMissingPrompt()
    expect(prompt.needed).toBe(true)
    expect(prompt.installCommand).toContain('nuclei-setup')
    expect(prompt.message).toMatch(/tools[/\\]bin/i)
    expect(prompt.message).toMatch(/authorized/i)
  })

  test('formatNucleiStatus distinguishes missing vs present', () => {
    expect(formatNucleiStatus({ available: false, source: 'missing' })).toMatch(
      /missing/i,
    )
    expect(
      formatNucleiStatus({
        available: true,
        source: 'path',
        version: '3.0.0',
        binaryPath: '/usr/bin/nuclei',
      }),
    ).toMatch(/3\.0\.0/)
  })
})

describe('hitsToObservations + evidence gate', () => {
  test('info-only hit stays below confirm threshold when judged alone with low conf', () => {
    const hits: NucleiHit[] = [
      {
        templateId: 'tech-detect',
        name: 'Tech Detect',
        severity: 'info',
        matchedAt: 'https://x/',
        evidence: 'detected nginx',
        raw: {},
      },
    ]
    const obs = hitsToObservations(hits)
    expect(obs[0]!.kind).toBe('scanner-template')
    // info confidence is intentionally lower
    expect(obs[0]!.confidence ?? 0).toBeLessThan(0.7)
  })

  test('extractor proof can confirm through the evidence gate', () => {
    const hits: NucleiHit[] = [
      {
        templateId: 'CVE-2021-41773',
        name: 'Apache path traversal',
        severity: 'critical',
        matchedAt: 'https://x/cgi-bin/.%2e/.%2e/etc/passwd',
        evidence: 'extracted=root:x:0:0:root',
        raw: {},
      },
    ]
    const obs = hitsToObservations(hits)
    const verdict = judgeVerification(obs)
    expect(verdict.confirmed).toBe(true)
  })
})
