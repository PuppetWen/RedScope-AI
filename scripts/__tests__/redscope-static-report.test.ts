import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
let folder: string
let run: string

beforeEach(async () => {
  folder = await mkdtemp(join(root, '.static-report-test-'))
  run = join(folder, 'run')
  await mkdir(join(run, 'raw/subdir'), { recursive: true })
  await writeFile(join(run, 'run.json'), JSON.stringify({ profile: { id: 'code-review' } }))
})

afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

async function report() {
  const proc = Bun.spawn([process.execPath, 'scripts/redscope-report-pipeline.ts',
    '--output-root', folder, '--run', run, '--json'], {
    cwd: root,
    env: { ...process.env, REDSCOPE_CONFIG_DIR: join(folder, 'config'), CLAUDE_CONFIG_DIR: join(folder, 'legacy') },
    stderr: 'pipe', stdout: 'ignore',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(stderr)
  return JSON.parse(await readFile(join(run, 'findings.json'), 'utf8')) as {
    warnings: string[]
    limitations: string[]
    findings: Array<{
      id: string; title: string; severity: string; status: string; target: string
      sourceTool: string; ruleId?: string; screenshots: unknown[]
      evidence: Array<{ id: string; path: string; jsonPointer: string }>
    }>
  }
}

describe('offline static-analysis reports', () => {
  test('preserves original positions and old finding IDs across files, formats and multiple runs', async () => {
    const hidden = 'SOURCE_CONTENT_MUST_STAY_IN_RAW'
    const native = { results: [null, ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ERROR', 'WARNING', 'INFO']
      .map(severity => ({ check_id: 'sample/rule', path: 'src/sample.ts', extra: { severity, lines: hidden } }))] }
    await writeFile(join(run, 'raw/semgrep.json'), JSON.stringify(native))
    const physicalLocation = {
      artifactLocation: { index: 0 }, region: { startLine: 8, snippet: { text: hidden } },
    }
    const result = { ruleIndex: 0, locations: [{ physicalLocation }], message: { text: hidden } }
    const sarif = JSON.stringify({
      version: '2.1.0', runs: [{
        tool: { driver: { name: 'CodeQL', rules: [{ id: 'sample/rule', defaultConfiguration: { level: 'error' } }] } },
        artifacts: [{ location: { uri: 'src/sample.ts' }, contents: { text: hidden } }],
        externalPropertyFileReferences: { results: [{ location: { uri: 'https://reports.invalid/private' } }] },
        results: [
          false, { ...result, kind: 'pass' }, { ...result, kind: 'open' },
          { ...result, suppressions: [{ status: 'accepted' }] }, result,
          { ...result, baselineState: 'absent' }, { ...result, kind: 'notApplicable' },
        ],
      }, {
        tool: { driver: { name: 'Semgrep' }, extensions: [{ name: 'Pack', rules: [{ id: 'pack/rule' }] }] },
        results: [
          { rule: { index: 0, toolComponent: { index: 0 } }, level: 'warning', suppressions: [{ status: 'underReview' }] },
          { ruleId: 'note', level: 'note', suppressions: [{ status: 'rejected' }] },
          { ruleId: 'none', level: 'none' }, { ruleId: 'review', kind: 'review' },
        ],
      }],
    })
    await writeFile(join(run, 'raw/a.SARIF'), '\uFEFF' + sarif)
    await writeFile(join(run, 'raw/subdir/duplicate.sarif.json'), '\uFEFF' + sarif)
    await writeFile(join(run, 'ignore.sarif'), sarif)
    const { findings, warnings } = await report()
    expect(findings.map(f => f.severity)).toEqual([
      'critical', 'high', 'medium', 'low', 'high', 'medium', 'info', 'high', 'medium', 'info', 'info', 'info',
    ])
    expect(findings[0]?.id).toBe('RS-CR-001')
    expect(findings[0]?.ruleId).toBe('sample/rule')
    expect(findings[0]?.evidence[0]?.jsonPointer).toBe('/results/1')
    expect(findings[7]).toMatchObject({ id: 'RS-CR-008', title: 'CodeQL finding: sample/rule', target: 'src/sample.ts:8', screenshots: [] })
    expect(findings[7]?.evidence[0]?.jsonPointer).toBe('/runs/0/results/4')
    expect(findings[8]?.title).toBe('Semgrep finding: pack/rule')
    expect(findings[8]?.ruleId).toBe('pack/rule')
    expect(findings[8]?.evidence[0]?.jsonPointer).toBe('/runs/1/results/0')
    expect(findings[11]?.status).toBe('suspected')
    const index = JSON.parse(await readFile(join(run, 'evidence-index.json'), 'utf8'))
    expect(index.evidence).toContainEqual(expect.objectContaining({
      id: findings[7]?.evidence[0]?.id, path: findings[7]?.evidence[0]?.path,
    }))
    expect(warnings.join('\n')).toContain('byte-identical')
    expect(warnings.join('\n')).toContain('1 accepted suppression(s), 4 inactive result(s), and 1 malformed')
    expect(warnings.join('\n')).toContain('external properties')
    expect(JSON.stringify(findings)).not.toContain(hidden)
    expect(await readFile(join(run, 'report.md'), 'utf8')).not.toContain(hidden)
  })

  test('continues past malformed reports and handles multiple distinct local SARIF exports', async () => {
    await writeFile(join(run, 'raw/semgrep.json'), '{')
    await writeFile(join(run, 'raw/bad.sarif'), '{')
    await writeFile(join(run, 'raw/version.sarif'), '{"version":"2.0.0","runs":[]}')
    const sarif = { version: '2.1.0', runs: [{
      tool: { driver: { name: 'Linter' } }, results: [{ ruleId: 'rule' }],
    }] }
    await writeFile(join(run, 'raw/subdir/a.sarif.json'), JSON.stringify(sarif))
    await writeFile(join(run, 'raw/subdir/b.sarif.json'), JSON.stringify(sarif, null, 2))
    const { findings, warnings } = await report()
    expect(findings).toHaveLength(2)
    expect(findings.every(f => f.status === 'suspected' && f.severity === 'medium')).toBe(true)
    expect(warnings.join('\n')).toContain('valid Semgrep JSON')
    expect(warnings.join('\n')).toContain('valid SARIF JSON')
    expect(warnings.join('\n')).toContain('expected a SARIF 2.1.0')
  })

  test('omits ruleId when only a display fallback is available', async () => {
    await writeFile(join(run, 'raw/semgrep.json'), '{"results":[{"path":"src/example.ts"}]}')
    await writeFile(join(run, 'raw/review.sarif'), JSON.stringify({
      version: '2.1.0', runs: [{
        tool: { driver: { name: 'Review tool' } },
        results: [{ message: { text: 'Inspect the location.' }, kind: 'review' }],
      }],
    }))
    const { findings } = await report()
    expect(findings.map(f => f.title)).toEqual(['Semgrep finding: semgrep-rule', 'Review tool finding: unspecified rule'])
    expect(findings.every(f => !Object.hasOwn(f, 'ruleId'))).toBe(true)
  })

  test('distinguishes an empty successful run from incomplete analysis', async () => {
    const runs = [
      { executionSuccessful: true },
      { executionSuccessful: false },
      { toolConfigurationNotifications: [{ level: 'error' }] },
    ].map(invocation => ({
      invocations: [invocation], tool: { driver: { name: 'Source review' } }, results: [],
    }))
    await writeFile(join(run, 'raw/incomplete.sarif'), JSON.stringify({ version: '2.1.0', runs }))
    const { findings, warnings } = await report()
    expect(findings).toHaveLength(0)
    expect(warnings.filter(message => message.includes('coverage may be incomplete'))).toHaveLength(2)
  })

  test('reports baseline coverage and keeps an unsuccessful analysis visible', async () => {
    const sha = 'd'.repeat(40)
    await writeFile(join(run, 'command-manifest.json'), JSON.stringify([{
      stepId: 'semgrep-ci', tool: 'semgrep', argv: ['semgrep', 'scan', '--baseline-commit', sha],
      status: 'failed', exitCode: 2, reason: 'baseline unavailable',
    }]))
    const { limitations } = await report()
    expect(limitations.some(item => item.includes(sha) && item.includes('newly detected'))).toBe(true)
    expect(limitations.some(item => item.includes('failed with exit code 2'))).toBe(true)
  })
})
