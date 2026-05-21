import { isAbortError } from 'src/utils/errors.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

export class FallbackSearchAdapter implements WebSearchAdapter {
  constructor(private readonly adapters: WebSearchAdapter[]) {}

  async search(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    let lastError: unknown

    for (const adapter of this.adapters) {
      try {
        return await adapter.search(query, options)
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
        lastError = error
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('All web search adapters failed')
  }
}
