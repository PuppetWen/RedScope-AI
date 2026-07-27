/**
 * Regenerate the interactive recon dashboard from the engagement file.
 *
 *   bun run scripts/gen-recon-map.ts [engagement.json] [out.html]
 *
 * Reads `redscope-engagement.json` (or the given path) and writes a
 * self-contained `redscope-recon-map.html` you can open in a browser to watch
 * the engagement: which hosts are under test, the internal-network graph, and
 * per-host findings. Serve the folder over http to get live auto-refresh.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderEngagementDashboardHtml } from '../src/utils/engagementDashboard.ts'
import {
  createEngagementGraph,
  normalizeEngagementGraph,
} from '../src/utils/engagementGraph.ts'

const inPath = resolve(process.cwd(), process.argv[2] ?? 'redscope-engagement.json')
const outPath = resolve(process.cwd(), process.argv[3] ?? 'redscope-recon-map.html')

const graph = existsSync(inPath)
  ? normalizeEngagementGraph(JSON.parse(readFileSync(inPath, 'utf8')))
  : createEngagementGraph('RedScope Engagement Map')

if (!existsSync(inPath)) {
  console.warn(`[gen-recon-map] ${inPath} not found — writing an empty map`)
}

const html = renderEngagementDashboardHtml(graph, {
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
})
writeFileSync(outPath, html)
console.log(
  `[gen-recon-map] wrote ${outPath} (${graph.hosts.length} hosts, ${graph.edges.length} links, ${html.length} bytes)`,
)
