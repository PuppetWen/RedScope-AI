import { describe, expect, test } from 'bun:test'
import {
  matchFingerprintToCatalog,
  mergePocEntries,
} from '../ndayCapture'
import { normalizePocCatalog } from '../pocCatalog'
import type { TechFingerprint } from '../techFingerprint'

describe('matchFingerprintToCatalog', () => {
  test('returns catalog entries whose product matches the fingerprint', () => {
    const catalog = normalizePocCatalog({
      entries: [
        {
          id: 'CVE-2021-26855',
          title: 'ProxyLogon',
          product: 'Microsoft Exchange Server',
          severity: 'critical',
        },
        {
          id: 'CVE-2021-44228',
          title: 'Log4Shell',
          product: 'Apache Log4j 2.x',
          severity: 'critical',
        },
      ],
    })
    const fp: TechFingerprint = {
      products: ['Microsoft Exchange Server'],
      signals: [],
    }
    const hits = matchFingerprintToCatalog(fp, catalog)
    expect(hits.map(h => h.entry.id)).toEqual(['CVE-2021-26855'])
    expect(hits[0]!.matchedProduct).toBe('Microsoft Exchange Server')
  })

  test('returns empty when fingerprint has no products', () => {
    const catalog = normalizePocCatalog({
      entries: [{ id: 'CVE-1', title: 'x', product: 'nginx' }],
    })
    expect(
      matchFingerprintToCatalog({ products: [], signals: [] }, catalog),
    ).toEqual([])
  })
})

describe('mergePocEntries', () => {
  test('appends only new ids and reports added count', () => {
    const base = normalizePocCatalog({
      entries: [{ id: 'CVE-1', title: 'One' }],
    })
    const { catalog, added } = mergePocEntries(base, [
      { id: 'CVE-1', title: 'dup', severity: 'low', references: [], requiresAuthorizedScope: true },
      {
        id: 'CVE-2',
        title: 'Two',
        severity: 'high',
        references: [],
        requiresAuthorizedScope: true,
      },
    ])
    expect(added).toBe(1)
    expect(catalog.entries.map(e => e.id)).toEqual(['CVE-1', 'CVE-2'])
  })
})
