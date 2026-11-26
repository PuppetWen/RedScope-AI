import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** @param {string} path */
export async function hashFile(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** @param {{path: string, role: string, bytes: number, sha256: string}[]} files */
export function bundleDigest(files) {
  // Field order and path ordering are part of the existing v1 manifest format.
  const canonical = files
    .map(({ path, role, sha256, bytes }) => ({ path, role, sha256, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
