# Security Policy

## Authorized use only

RedScope AI is a security-engineering and authorized red-team assistant. Use it
**only** against systems, networks, accounts, logs, and repositories you are
explicitly authorized to assess.

- Written rules of engagement (RoE) / scope documents are required for active
  testing.
- Scope, rate limits, and evidence retention are first-class project
  constraints — not optional.
- The project does **not** support unauthorized scanning, mass targeting, or
  detection evasion for malicious purposes.

## First-run collection (opt-in)

On first launch RedScope can prompt (or you can run
`bun run redscope:first-run`) to:

1. **Scrape ~500 public free-proxy endpoints** from public list pages, for IP
   rotation during authorized testing. The pool auto-refreshes about every 6
   hours when you opted in.
2. **Silently collect ≥100 PoC / n-day references** (CVE metadata + official
   advisory links only). Individual entries are **not** dumped to the console.

Both steps are optional. Declining is fine; you can run the collectors later:

```bash
bun run redscope:first-run
bun run redscope:proxy-scrape -- --limit 500
bun run redscope:poc-catalog
```

Public free-proxy nodes are noisy and short-lived. Always health-check before
use, and only send traffic at in-scope targets.

## What RedScope will and will not do

### Will

- Help plan and execute **authorized** penetration tests, recon, and analysis
  inside a declared scope.
- Auto-write per-host **progress / activity / findings** into
  `redscope-engagement.json` and refresh the recon map during testing.
- Index **public** vulnerability / advisory metadata and, when a target
  fingerprint matches, capture related n-day references into the local catalog.
- Rotate among **user-opted public free proxies** and/or **referee-provided**
  egress nodes.
- Gate “vulnerability confirmed” behind **evidence-based verification** — version
  banners alone are not enough (high false-positive risk).

### Will not

- Claim a host is vulnerable from a version string / Server banner alone.
- **Ship or generate weaponized exploit payloads inside this repository.**
  RedScope stores CVE/advisory *references*, fingerprint→n-day metadata, and
  evidence-gated verification hooks. Live exploitation tooling (if any) must
  come from **external, operator-installed, authorized** scanners (e.g. nuclei
  under an approved profile) and still pass the evidence gate before a finding
  is marked confirmed/exploited.
- Bypass the permission / auto-mode gates without an explicit full-access
  (bypassPermissions / auto) opt-in from the operator.
- Test out-of-scope targets. Full-access autonomy still requires a declared
  engagement scope.

## Silent proxy rotation during tests

While a test step runs, RedScope can:

1. Health-check the current egress IP (TCP)
2. On failure / HTTP block (403/407/429/…) **silently** cool that node
3. Switch to the next live proxy and continue the same request/step

```ts
import { withSilentEgress, fetchWithSilentEgress } from './src/utils/silentEgress.ts'
import { startTestStep, probeFingerprintAndCaptureNdays, finishTestStep } from './src/utils/testSession.ts'
```

No operator prompt mid-test — rotation is automatic within the configured pool.

## npm / bun install bootstrap

`postinstall` runs `scripts/postinstall-redscope-bootstrap.cjs`, which (unless
skipped) downloads ~500 public free-proxy nodes and builds ≥100 PoC references
into the user config / workspace. Non-fatal on failure.

```bash
# skip
REDSCOPE_SKIP_FIRST_RUN_BOOTSTRAP=1 npm i -g @redscope-ai/redscope
# force redo
REDSCOPE_FORCE_FIRST_RUN_BOOTSTRAP=1 bun run scripts/postinstall-redscope-bootstrap.cjs
```

## Egress / IP switching

```bash
# Public free-proxy pool (after first-run opt-in or manual scrape)
bun run redscope:proxy-scrape -- --limit 500
bun run redscope:proxy-scrape -- --status

# Health-check + select through whatever pool loadEgressConfig() resolves
bun run redscope:egress-refresh -- --status
bun run redscope:egress-refresh -- --check
bun run redscope:egress-refresh -- --select --target <in-scope-host>
```

`loadEgressConfig()` preference order:

1. `REDSCOPE_EGRESS_CONFIG` / `REDSCOPE_TOOLS_EGRESS_CONFIG`
2. Public free-proxy pool (`public-free-proxies.json`) when present
3. Referee-provided authorized egress config

## Fingerprint → n-day capture

```bash
bun run redscope:fingerprint-nday -- --url https://in-scope.example
bun run redscope:fingerprint-nday -- --url https://in-scope.example --host-id ext-web
```

Matching products pull local catalog hits and (unless `--offline`) query NVD
keyword search. New CVE references are appended to `redscope-poc-catalog.json`
for next time. This stores metadata + links, not exploit code.

## Nuclei (external scanner)

When template verification is needed and nuclei is not installed, RedScope
prompts the operator to download it **into the current project**:

```bash
bun run redscope:nuclei-setup
# → tools/bin/nuclei(.exe)
```

After install, `maybeRunNucleiVerification()` / profile steps can invoke it
automatically against in-scope targets. Hits still pass the evidence gate
before a finding is confirmed.

## Evidence-based verification

`pocVerification.judgeVerification()` refuses to confirm findings when the only
signal is a version/banner match. Confirmation requires non-version evidence
(body marker, file-read contents, auth-bypass proof, OOB token, scanner
template hit with proof, etc.). Use `verifyAndRecordFinding()` to write through
to the engagement graph with progress auto-update.

## Engagement progress auto-write

```ts
import {
  beginHostTest,
  reportHostProgress,
  reportHostFinding,
  completeHostTest,
} from './src/utils/engagementProgress.ts'
```

These helpers persist `redscope-engagement.json` and regenerate
`redscope-recon-map.html` so the HUD and SVG map stay live during a test.

## PoC reference catalog

```bash
bun run redscope:poc-catalog
```

Writes / refreshes `redscope-poc-catalog.json` (≥100 scope-gated public
CVE/advisory references). Planning material, not an executable arsenal.

## Recon map

```bash
bun run redscope:recon-map
```

## Reporting a vulnerability in RedScope itself

If you find a security issue **in this project** (the CLI, build pipeline, or
bundled scripts), please open a private report via the repository’s security
advisory channel or contact the maintainers.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | yes       |
