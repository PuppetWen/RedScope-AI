/**
 * Compatibility rewrites applied to generated bundles.
 *
 * Google authentication dependencies contain both CommonJS and ESM fallbacks
 * that resolve node-fetch at runtime. node-fetch is only a transitive
 * development dependency in this project, so those references break after the
 * published package is installed. RedScope's supported Node and Bun runtimes
 * already provide a standards-compatible global fetch implementation.
 */
export function patchNodeFetchWithNativeFetch(content: string): {
  content: string
  patched: number
} {
  let patched = 0

  const commonJsFallback =
    /__importDefault\(__require\((["'])node-fetch\1\)\)/g
  const esmFallback =
    /\(await import\((["'])node-fetch\1\)\)\.default/g

  const patchedCommonJs = content.replace(commonJsFallback, () => {
    patched++
    return '{ default: globalThis.fetch.bind(globalThis) }'
  })
  const patchedContent = patchedCommonJs.replace(esmFallback, () => {
    patched++
    return 'globalThis.fetch.bind(globalThis)'
  })

  return { content: patchedContent, patched }
}
