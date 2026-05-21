import type { SearchOptions, SearchResult } from './types.js'

const DEFAULT_NUM_RESULTS = 8
const MAX_NUM_RESULTS = 20

export function getSearchResultLimit(numResults: number | undefined): number {
  if (typeof numResults !== 'number' || !Number.isFinite(numResults)) {
    return DEFAULT_NUM_RESULTS
  }

  return Math.min(MAX_NUM_RESULTS, Math.max(1, Math.floor(numResults)))
}

export function filterAndLimitSearchResults(
  results: SearchResult[],
  options: SearchOptions,
): SearchResult[] {
  const limit = getSearchResultLimit(options.numResults)
  const filtered: SearchResult[] = []
  const seenUrls = new Set<string>()

  for (const result of results) {
    const normalizedUrl = normalizeResultUrl(result.url)
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue
    }

    const hostname = new URL(normalizedUrl).hostname
    if (
      options.allowedDomains?.length &&
      !options.allowedDomains.some(domain => hostnameMatchesDomain(hostname, domain))
    ) {
      continue
    }
    if (
      options.blockedDomains?.length &&
      options.blockedDomains.some(domain => hostnameMatchesDomain(hostname, domain))
    ) {
      continue
    }

    seenUrls.add(normalizedUrl)
    filtered.push({
      title: result.title,
      url: normalizedUrl,
      snippet: result.snippet,
    })

    if (filtered.length >= limit) {
      break
    }
  }

  return filtered
}

function normalizeResultUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return undefined
  }
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain) {
    return false
  }

  const normalizedHostname = hostname.toLowerCase()
  return (
    normalizedHostname === normalizedDomain ||
    normalizedHostname.endsWith('.' + normalizedDomain)
  )
}
