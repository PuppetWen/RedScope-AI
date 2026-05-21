import { describe, expect, test } from 'bun:test'
import {
  filterAndLimitSearchResults,
  getSearchResultLimit,
} from '../adapters/resultUtils'

describe('getSearchResultLimit', () => {
  test('defaults to eight results', () => {
    expect(getSearchResultLimit(undefined)).toBe(8)
  })

  test('clamps invalid and large result counts', () => {
    expect(getSearchResultLimit(0)).toBe(1)
    expect(getSearchResultLimit(50)).toBe(20)
    expect(getSearchResultLimit(3.8)).toBe(3)
  })
})

describe('filterAndLimitSearchResults', () => {
  const results = [
    { title: 'One', url: 'https://docs.example.com/a#intro' },
    { title: 'Duplicate', url: 'https://docs.example.com/a' },
    { title: 'Two', url: 'https://api.example.com/b' },
    { title: 'Other', url: 'https://other.test/c' },
    { title: 'Bad', url: 'javascript:alert(1)' },
  ]

  test('deduplicates normalized URLs and limits result count', () => {
    expect(filterAndLimitSearchResults(results, { numResults: 2 })).toEqual([
      { title: 'One', url: 'https://docs.example.com/a', snippet: undefined },
      { title: 'Two', url: 'https://api.example.com/b', snippet: undefined },
    ])
  })

  test('filters allowed domains including subdomains', () => {
    expect(
      filterAndLimitSearchResults(results, {
        allowedDomains: ['example.com'],
      }).map(result => result.url),
    ).toEqual(['https://docs.example.com/a', 'https://api.example.com/b'])
  })

  test('filters blocked domains including subdomains', () => {
    expect(
      filterAndLimitSearchResults(results, {
        blockedDomains: ['example.com'],
      }).map(result => result.url),
    ).toEqual(['https://other.test/c'])
  })
})
