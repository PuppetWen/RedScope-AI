import { describe, expect, test } from 'bun:test'
import {
  formatPocCatalogStatus,
  normalizePocCatalog,
  summarizePocCatalog,
} from '../pocCatalog'

describe('normalizePocCatalog', () => {
  test('keeps valid entries, drops entries missing id/title', () => {
    const catalog = normalizePocCatalog({
      entries: [
        { id: 'CVE-1', title: 'One', severity: 'critical' },
        { id: 'CVE-2' }, // no title
        { title: 'no id' },
      ],
    })
    expect(catalog.entries.map(e => e.id)).toEqual(['CVE-1'])
  })

  test('de-duplicates repeated ids (first wins)', () => {
    const catalog = normalizePocCatalog({
      entries: [
        { id: 'CVE-1', title: 'First' },
        { id: 'CVE-1', title: 'Duplicate' },
      ],
    })
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]!.title).toBe('First')
  })

  test('defaults scope-gating to true and normalizes severity/cvss', () => {
    const catalog = normalizePocCatalog({
      entries: [
        { id: 'CVE-1', title: 'One', severity: 'BOGUS', cvss: 42 },
        {
          id: 'CVE-2',
          title: 'Two',
          requiresAuthorizedScope: false,
          severity: 'High',
        },
      ],
    })
    const [a, b] = catalog.entries
    expect(a!.requiresAuthorizedScope).toBe(true)
    expect(a!.severity).toBe('unknown')
    expect(a!.cvss).toBe(10) // clamped to [0,10]
    expect(b!.requiresAuthorizedScope).toBe(false)
    expect(b!.severity).toBe('high') // case-normalized
  })
})

describe('summarizePocCatalog / formatPocCatalogStatus', () => {
  test('empty catalog reports zero and a hint', () => {
    const summary = summarizePocCatalog(null)
    expect(summary.present).toBe(false)
    expect(summary.total).toBe(0)
    expect(formatPocCatalogStatus(summary)).toContain('PoC references: 0')
  })

  test('counts totals, scope-gated, severities and categories', () => {
    const catalog = normalizePocCatalog({
      entries: [
        {
          id: 'CVE-1',
          title: 'One',
          severity: 'critical',
          category: 'rce',
        },
        {
          id: 'CVE-2',
          title: 'Two',
          severity: 'high',
          category: 'ssrf',
          requiresAuthorizedScope: false,
        },
        {
          id: 'CVE-3',
          title: 'Three',
          severity: 'critical',
          category: 'rce',
        },
      ],
    })
    const summary = summarizePocCatalog(catalog)
    expect(summary.total).toBe(3)
    expect(summary.scopeGated).toBe(2)
    expect(summary.bySeverity.critical).toBe(2)
    expect(summary.bySeverity.high).toBe(1)
    expect(summary.categories).toEqual(['rce', 'ssrf'])
    const text = formatPocCatalogStatus(summary)
    expect(text).toContain('PoC references: 3 (2 scope-gated)')
    expect(text).toContain('critical=2')
  })
})
