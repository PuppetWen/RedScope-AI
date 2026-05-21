# RedScope Tools Directory

This directory is the only approved place for external security tools used by
RedScope workflows.

Current policy:

- Do not install tools globally.
- Do not run active scanners by default.
- Use `redscope-tool-registry.json` to choose candidate tools.
- Use `redscope-source-registry.json` to maintain quarantined PoC/template
  source repositories for analyst reference.
- Download tools here only after the user supplies authorization and asks for a
  specific tool or active phase.
- Record version, source URL, checksum, and install notes for every downloaded
  binary.
- Keep target scope in a separate JSON file based on
  `authorized-scope.example.json`.

## env.config defaults

RedScope CLI runtime settings and RedScope security-suite defaults are managed
from the user config directory `env.config` file, normally
`~/.redscope/env.config`. CLI flags still take precedence for a single run.

Useful tools/workflow keys:

```dotenv
# REDSCOPE_TOOLS_ROOT=tools
# REDSCOPE_TOOLS_TOOL_REGISTRY=tools/redscope-tool-registry.json
# REDSCOPE_TOOLS_SOURCE_REGISTRY=tools/redscope-source-registry.json
# REDSCOPE_TOOLS_PROFILE_REGISTRY=tools/redscope-run-profiles.json
# REDSCOPE_TOOLS_SOURCE_ROOT=tools/sources
# REDSCOPE_TOOLS_SOURCE_CACHE_ROOT=tools/cache/sources
# REDSCOPE_TOOLS_SOURCE_STATE=tools/manifests/redscope-source-state.json
# REDSCOPE_TOOLS_SOURCE_UPDATE_INTERVAL_DAYS=7
# REDSCOPE_TOOLS_EGRESS_CONFIG=tools/authorized-egress.example.json
# REDSCOPE_TOOLS_EGRESS_STATE=tools/manifests/redscope-egress-state.json
# REDSCOPE_AUTO_EGRESS=1
# REDSCOPE_AUTO_EGRESS_CONFIG=tools/authorized-egress.referee-provided.json
# REDSCOPE_EGRESS_POOL=referee-provided-traffic-simulation
# REDSCOPE_EGRESS_MAX_SWITCHES=8
# REDSCOPE_EGRESS_VALIDATE_CONNECTIVITY=1
# REDSCOPE_EGRESS_CONNECTIVITY_TIMEOUT_MS=3000
# REDSCOPE_EGRESS_AVOID_USED_PER_TARGET=1
# REDSCOPE_TOOLS_OUTPUT_ROOT=tools/outputs
# REDSCOPE_TOOLS_MEMORY_ROOT=tools/memory
# REDSCOPE_TOOLS_DEFAULT_SCOPE=tools/scope.json
# REDSCOPE_TOOLS_EXTERNAL_POC_PROVIDERS=github,bing,google,baidu
# WEB_SEARCH_ADAPTER=auto
# BRAVE_SEARCH_API_KEY=
# NVD_API_KEY=
```

The JSON registries remain the source of structured tool/source/profile policy;
`env.config` only controls default paths, provider choices, API keys, and update
intervals.

## Controlled installer

Use the project-local installer instead of package managers or global PATH
changes:

```bash
bun run redscope:tool -- --list
bun run redscope:tool -- --tool httpx --version <pinned-tag> --scope tools/scope.json
```

Installer guarantees:

- Tool archives are downloaded under `tools/cache/`.
- Extracted files stay under `tools/bin/<tool>/<version>/`.
- Manifests are written under `tools/manifests/`.
- Version input is required; implicit latest installs are not allowed.
- Baseline, active, and restricted tools require a scope file whose
  `testLevels` allow the tool risk level.
- The installer never runs scanners, modifies system package managers, or
  updates shell PATH.

If upstream publishes a checksum file or GitHub asset digest, the installer
verifies it. Otherwise it records the computed SHA-256 as `recorded only` in the
manifest. A reviewer can also force verification with `--sha256 <hash>`.

## PoC and template source updates

RedScope can maintain project-local source repositories under `tools/sources/`
for analyst reference, template review, and authorized coverage planning:

```bash
bun run redscope:sources -- --list
bun run redscope:sources -- --check
bun run redscope:sources -- --update --yes
```

Source update policy:

- The source registry is `tools/redscope-source-registry.json`.
- Enabled sources default to a seven-day update interval.
- Update state is written to `tools/manifests/redscope-source-state.json`.
- Per-source update manifests are written under `tools/manifests/sources/`.
- Source archives are cached under `tools/cache/sources/`.
- Extracted source trees are written under `tools/sources/<source-id>/`.
- `redscope:command` and `redscope:workflow` check this state before workflow
  execution. In an interactive terminal they prompt before updating. In
  non-interactive mode they stop and print the update command.

Safety boundaries:

- Public PoC repositories are untrusted. Treat everything in `tools/sources/`
  as quarantined reference content.
- RedScope workflows must not execute PoC code directly from `tools/sources/`.
- Active scanners and restricted validation still require separate scope,
  profile, rate-limit, and confirmation controls.
- Proxy discovery, public free proxy collection, and proxy rotation are not part
  of this registry. Use only project-authorized egress configuration outside
  this source updater.

## Authorized egress configuration

RedScope supports project-authorized egress configuration for red-team
engagements where the rules of engagement approve specific owned or
customer-approved exit nodes:

```bash
bun run redscope:egress -- --check --config tools/authorized-egress.example.json
bun run redscope:egress -- --list --config tools/authorized-egress.example.json
bun run redscope:egress -- --check --config tools/authorized-egress.example.json --target https://www.example.com/ --strict
bun run redscope:egress -- --check --config tools/authorized-egress.example.json --pool example-authorized-egress --node example-corporate-vpn --emit-env
bun run redscope:egress -- --blocked --config tools/authorized-egress.example.json --pool example-authorized-egress --node example-corporate-vpn --target https://www.example.com/ --status 403 --reason "target-side IP block" --emit-env
bun run redscope:egress -- --next --config tools/authorized-egress.example.json --pool example-authorized-egress --target https://www.example.com/ --emit-env
bun run redscope:egress -- --health --config tools/authorized-egress.referee-provided.json --pool referee-provided-traffic-simulation --target https://www.example.com/ --emit-env
```

Egress policy:

- The egress config is a whitelist of approved pools and nodes, not a proxy
  scraper.
- Public free proxy collection, scraped proxy lists, Tor exits, and anonymous
  third-party relay pools are rejected.
- Each pool must include owner, authorization window, emergency contact,
  allowed targets, rate limits, and at least one verified node.
- Each node must use an approved kind such as `corporate-egress`,
  `cloud-egress`, `customer-approved-proxy`, `owned-vpn`, `lab-vpn`,
  `private-relay`, or `dedicated-vps`.
- Store credentials in `REDSCOPE_*` environment variables. Do not put usernames
  or passwords in proxy endpoint URLs.
- Use `--target` before a run to verify that the selected egress pool is
  approved for the target in the current rules of engagement.
- The example config uses a one-day egress review interval and records
  block/switch state under `tools/manifests/redscope-egress-state.json`.
- When a target-side block signal is observed, record it with `--blocked`.
  RedScope prints a user-facing warning and selects the next node from the same
  approved pool; it never falls back to public proxy sources.
- Referee-provided exercise nodes can use `kind: "referee-approved-proxy"` and
  `allowedTargets.any=true` when the rules of engagement explicitly approve the
  pool for realistic traffic simulation. Keep these in a separate file such as
  `tools/authorized-egress.referee-provided.json`.
- Use `--health` when RedScope should pick a currently reachable node from an
  approved pool. The check is a bounded TCP reachability check; it does not add
  unapproved nodes.
- A config can opt in to automatic profile-run egress with
  `policy.autoUseForAuthorizedTesting=true`. The referee-provided file is opted
  in, so executed network profiles automatically select a node, inject
  `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, record target-side block signals, and
  switch to the next approved node without prompting.
- Automatic egress can require a bounded reachability check before selecting or
  switching nodes with `policy.validateBeforeUse=true` and
  `policy.connectivityCheckTimeoutMs`. The referee-provided file enables this
  so dead nodes are skipped during the run.
- Automatic egress records selected nodes in `usedNodes` under the configured
  state file. With `policy.avoidPreviouslyUsedNodesPerTarget=true`, RedScope
  will not reuse a source IP that has already been used against the same target.
- Automatic switching is scoped to the configured pool and defaults to HTTP
  status `403`, `407`, `429`, and `451` plus target-tool failures. It never
  scrapes, discovers, or falls back to public proxy sources. Set
  `REDSCOPE_AUTO_EGRESS=0` to temporarily disable automatic egress.

## Execution profiles

Use deterministic RedScope profiles instead of free-form scanner commands:

```bash
bun run redscope:profile -- --list
bun run redscope:profile -- --profile baseline-url-review --scope tools/scope.json --target https://www.example.com/ --dry-run
bun run redscope:profile -- --profile authorized-third-party-scanner-baseline --scope tools/scope.json --target https://www.example.com/ --execute --confirm-active
bun run redscope:profile -- --profile authorized-gitleaks-secret-scan --scope tools/scope.json --repository . --execute --confirm-active
bun run redscope:profile -- --profile authorized-semgrep-sast --scope tools/scope.json --repository . --semgrep-config .semgrep.yml --execute --confirm-active
bun run redscope:batch -- --profile authorized-http-probe --scope tools/scope.json --targets tools/targets.txt --execute --confirm-active
```

Profile runner guarantees:

- Every profile reads and validates a scope file before planning or execution.
- Target matching honors `targets` and `exclusions` from the scope file.
- Profile and scope rate limits are merged by taking the lower limit.
- Run artifacts are written under `tools/outputs/<profile>/<run-id>/`.
- Executed network profiles write `egress-manifest.json` in the run directory
  when authorized automatic egress is enabled.
- The default mode writes a plan only; tools run only with `--execute`.
- Active and restricted profiles require `--confirm-active` in addition to
  `--execute`.
- External tools must already have project-local manifests from the controlled
  installer.
- Third-party scanner execution is available only through written profiles such
  as `authorized-third-party-scanner-baseline`,
  `authorized-gitleaks-secret-scan`, and `authorized-semgrep-sast`; those
  profiles require `testLevels.restricted` plus
  `scope.scannerExecution.approvedBy`, `approvalReference`, `changeWindow`, and
  per-tool `allowedTools`.
- Scanner steps are skipped when their tool is not present in
  `scope.scannerExecution.allowedTools`, even if the profile contains the step.

## Batch target runner

Use the batch runner when a referee supplies a target list for a timed
engagement. The list is newline-delimited and can contain any number of
targets; it is not fixed to 20 entries.

```bash
bun run redscope:batch -- --profile authorized-http-probe --scope tools/scope.json --targets tools/targets.txt
bun run redscope:batch -- --profile authorized-http-probe --scope tools/scope.json --targets tools/targets.txt --execute --confirm-active --json
```

Batch runner guarantees:

- Reads the target list once, skipping blank lines and `#` comments.
- Runs targets sequentially through `redscope:workflow`, preserving per-target
  scope validation, profile rate limits, reporting, observability, and egress
  handling.
- Continues after individual target failures by default and records failures in
  `tools/outputs/batches/<batch-id>/batch-manifest.json`.
- Summarizes completed runs, failed targets, target-side egress block signals,
  and evidence directories.
- Supports `--start-at` and `--limit` when the referee changes the target count
  or asks for a partial rerun.

Run artifacts:

```text
tools/outputs/<profile>/<run-id>/
  run.json
  scope.snapshot.json
  targets.txt
  command-manifest.json
  findings.json
  evidence-index.json
  report-manifest.json
  workflow-manifest.json
  report.md
  raw/
```

## Report pipeline

Normalize run artifacts into finding JSON, an evidence index, and a Markdown
report:

```bash
bun run redscope:report -- --run tools/outputs/<profile>/<run-id>
bun run redscope:report -- --latest --profile baseline-url-review
```

Report pipeline guarantees:

- Reads project-local run directories under `tools/outputs/`.
- Preserves the run manifest, scope snapshot, command manifest, timestamps, and
  target metadata as report source material.
- Writes normalized findings to `findings.json`.
- Writes SHA-256 evidence references to `evidence-index.json`.
- Replaces the run's placeholder `report.md` with a structured RedScope report.
- Does not copy raw secrets, exploit payloads, or response bodies into
  normalized findings.
- Supports baseline URL, repository secret/SAST, httpx JSONL, and nuclei JSONL
  outputs.

## Observability and memory

Ingest completed run/report artifacts into a project-local memory index:

```bash
bun run redscope:observe -- --run tools/outputs/<profile>/<run-id>
bun run redscope:observe -- --latest --profile baseline-url-review
bun run redscope:observe -- --all
```

Observation guarantees:

- Writes a local memory document to `tools/memory/redscope-memory.json`.
- Tracks run summaries, asset relationships, profile decisions, tool-output
  references, and reusable lessons.
- Uses run/report artifacts as source material; it does not run scanners.
- Stores summaries and file references only.
- Does not store raw secrets, exploit payloads, or response bodies.
- Can be used as a stable local source before any optional future Langfuse or
  tracing integration.

Export the local memory index as a lightweight graph JSON:

```bash
bun run redscope:graph -- --memory-root tools/memory --json
bun run redscope:graph -- --memory tools/memory/redscope-memory.json --output tools/memory/redscope-memory-graph.json --json
bun run redscope:graph -- --memory-root tools/memory --cypher-output tools/memory/redscope-memory-graph.cypher --json
bun run redscope:graph-import -- --graph tools/memory/redscope-memory-graph.json --retention-days 30 --access-label redscope_internal --owner "Security Team" --purpose "authorized engagement review" --json
```

Graph export guarantees:

- Writes `tools/memory/redscope-memory-graph.json` by default.
- Uses only the local summary memory file as input.
- Creates nodes for runs, assets, profiles, owners, decisions, tool outputs,
  tools, and lessons, plus typed edges between them.
- Does not introduce a database, contact external services, or store raw
  findings, evidence bodies, secrets, payloads, response bodies, or artifact
  contents.
- Optional `--cypher-output` writes a local Neo4j/Cypher import file from the
  same sanitized graph; it does not connect to a graph database.
- `redscope:graph-import` prepares a local graph import bundle from the graph
  JSON/Cypher artifact and requires retention days, an access-control label,
  owner, and purpose before writing an import manifest.
- Live graph import is opt-in only: `--execute` also requires
  `--confirm-import`, `--cypher-shell`, a Neo4j URI, and credentials supplied
  through environment variables.

## Scope draft generation

Use draft generation to turn local evidence into reviewer-ready scope snippets
without mutating the scope file or executing any validators:

```bash
bun run redscope:drafts -- --run tools/outputs/authorized-poc-candidate-validation/<run-id> --json
bun run redscope:drafts -- --latest --profile authorized-poc-candidate-validation --json
bun run redscope:drafts -- --routes tools/artifacts/example-api-routes.json --role-matrix tools/artifacts/example-role-matrix.json --scope tools/authorized-active-scope.example.json --json
```

Draft behavior:

- Writes `drafts/low-impact-validator-drafts.json` for validation-ready PoC
  candidates from `raw/validation-evidence-gates.json`.
- Writes `drafts/business-logic-testcase-drafts.json` from route inventories,
  workflow maps, and owner-supplied role matrices.
- Writes `drafts/draft-manifest.json` describing generated files and policy.
- Never edits the source scope file automatically.
- Never executes network requests, scanners, PoC code, login flows, or
  validators.
- Keeps approval explicit: generated low-impact entries must be reviewed before
  copying into `scope.validation.validators`, and generated business-logic
  entries must be reviewed before copying into
  `scope.logicValidation.testCases`.
- Generated validator/test-case objects include draft notes and
  `fieldsNeedingAnalystReview` so a reviewer can fill path, assertion, impact,
  remediation, actor matrix, and separate approval metadata before execution.
- State-changing route drafts remain `evidence-only` by default. Promote one
  manually to `approved-state-changing-http` only after the separate stateful
  approval, change window, request body, and rollback plan are reviewed.

## Delivery package

Generate a local delivery package after report normalization:

```bash
bun run redscope:deliver -- --run tools/outputs/<profile>/<run-id> --status ready-for-review --reviewer "Analyst Name"
bun run redscope:deliver -- --latest --profile threat-trace-artifact-review --status draft --json
bun run redscope:deliver -- --latest --profile threat-trace-artifact-review --triage-file tools/triage.json --pdf --trace tools/outputs/delivery-trace.jsonl
```

Delivery guarantees:

- Reads an existing run directory and writes delivery artifacts under
  `delivery/` inside that run.
- Creates `triage.json` with finding-level triage defaults:
  `needs-review` for suspected/confirmed findings and `informational` for
  informational findings.
- Accepts `--triage-file <path>` to apply finding-level manual triage status,
  owner, and reviewer-note overrides without editing normalized findings.
- Creates `reviewer-notes.md` with a delivery checklist and reviewer note.
- Creates `report-signature.json`, a local SHA-256 integrity manifest covering
  run, report, evidence, workflow, triage, reviewer notes, HTML files, optional
  PDF files, and optional trace-event files.
- Creates `report.html` as a self-contained HTML rendering of `report.md`.
- Creates `report.pdf` when `--pdf` is supplied. This is a lightweight local
  PDF export of the Markdown report for reviewer packets.
- Writes `delivery/trace-event.json` and appends a JSONL event to `--trace`
  when a local trace path is supplied.
- The signature is a local integrity manifest, not a PKI certificate or legal
  attestation.
- Does not copy raw secrets, payloads, response bodies, or full incident
  artifact contents into delivery metadata.

## Workflow command

Run the safe end-to-end RedScope workflow from one command:

```bash
bun run redscope:workflow -- --profile baseline-url-review --scope tools/scope.json --target https://www.example.com/
bun run redscope:workflow -- --profile baseline-url-review --scope tools/scope.json --target https://www.example.com/ --execute
```

Workflow guarantees:

- Orchestrates the existing profile, report, and observability stages.
- Does not accept free-form scanner commands.
- Defaults to a plan-only profile run; tools run only with `--execute`.
- Active and restricted profile execution still requires `--confirm-active`.
- `--dry-run` validates and prints the profile plan without writing files.
- Writes `workflow-manifest.json` into the run directory.
- Supports `--skip-report` and `--skip-observe` for staged review.

## Slash command adapter

Use the same workflow path from `/redscope` or another interactive entrypoint:

```bash
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --json
bun run redscope:command -- --repository . --scope tools/scope.json --json
```

Adapter guarantees:

- Infers a deterministic profile for common inputs:
  - URL: `baseline-url-review`
  - domain or company: `passive-company-recon`
  - repository: `repo-secret-and-sast`
  - local artifact/log path: `threat-trace-artifact-review`
- Supports explicit profile selection with `--profile`, `--http-probe`,
  `--gitleaks-scan`, `--semgrep-sast`, `--nuclei-low`,
  `--scanner-baseline`, `--low-impact-validate`, `--logic-validate`, or
  `--stateful-logic-validate`.
- Supports `--poc-validate` for the gated PoC/template candidate workflow.
- Returns `needs-scope` instead of creating artifacts when no scope file is
  supplied.
- Calls `redscope:workflow` for all artifact-producing runs.
- Does not run raw scanners or accept arbitrary shell commands.
- Passes `--execute` and `--confirm-active` through only when supplied.

## PoC candidate validation

Use the PoC candidate profile only inside written active authorization:

```bash
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --poc-validate --execute --confirm-active --json
```

Validation behavior:

- Fetches the authorized URL once and records selected fingerprint headers plus
  bounded body/cookie signature metadata. Raw response bodies and cookie values
  are not persisted.
- Extracts product, version, same-context product/version pair evidence, and
  derived technology observations from target metadata.
- Matches those terms against downloaded source trees under `tools/sources/`
  with source trust, CVE identifier, version, and security-context scoring.
- Searches GitHub, Bing, Google, and Baidu for recent public PoC/template
  leads using fingerprint terms only. Target hostnames are not included in
  external search queries.
- Correlates CVE/product/version hints with NVD vulnerability metadata as an
  authoritative advisory layer for prioritization.
- Writes `raw/poc-validation-plan.json` with candidate PoC/template files and
  gated follow-up attempts.
- Writes `raw/poc-search-enrichment.json` with external search queries,
  candidate links, provider errors, and safety policy metadata.
- Writes `raw/vulnerability-advisory-enrichment.json` with NVD query status,
  CVE metadata, CVSS/KEV fields when present, references, and safety policy
  metadata.
- Writes `raw/validation-evidence-gates.json` with automatic non-exploit
  evidence gates for fingerprint confidence, same-context versions, advisory
  correlation, external CVE corroboration, reviewed-template source, and the
  no-exploit-execution boundary.
- Keeps weak product-only hits in `triageQueue`; they are not promoted to
  validation attempts.
- Creates `raw/screenshots/` as the place to attach approved browser/tool
  screenshots for the report.
- Does not execute arbitrary PoC code from downloaded repositories.
- Does not download repositories or execute PoC code from external search
  results.
- Does not treat public advisory metadata as proof of target exploitability.
- Does not run exploit payloads during automatic validation gates; ready
  candidates still require a separately approved low-impact validation profile.
- Follow-up validation must use a separately reviewed low-impact profile or
  manual analyst approval.

## EVTX deep parser

Default artifact reports keep EVTX handling bounded to metadata. For a
separately approved defensive forensics workflow, run the explicit EVTX helper:

```bash
bun run redscope:evtx -- --artifact tools/artifacts/security.evtx --json
bun run redscope:evtx -- --artifact tools/artifacts/security.evtx --max-chunks 512 --max-events 10000 --output tools/outputs/evtx/security-summary.json --json
```

EVTX parser guarantees:

- It is not part of default report generation.
- It reads only a local `.evtx` file under the project workspace.
- It scans EVTX file headers, chunk headers, event record headers, timestamps,
  record identifier ranges, record size buckets, per-hour event counts, and
  bounded BinXML token/template metadata.
- It does not render Windows Event XML.
- It does not copy raw event bodies, payloads, secrets, or message text into
  the summary.

## Low-impact target validation

Use the low-impact validator only after candidate triage has identified an
approved, non-destructive assertion to verify on the scoped target:

```bash
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --low-impact-validate --execute --confirm-active --json
```

Scope requirements:

- `scope.testLevels` must include `active`.
- `scope.validation.approvedBy` and `scope.validation.approvalReference` must
  identify the separate validator approval.
- `scope.validation.validators` lists the only validators that may run.
- Each validator is same-origin and same-scope relative to the target URL.

Validator behavior:

- Supports only approved GET/HEAD checks: HTTP status, header present, header
  absent, header value contains an approved marker, or bounded body marker.
- Sends no request body and performs at most one request per validator.
- Does not execute public PoC code, exploit payloads, fuzzing, brute force,
  credential checks, upload checks, or destructive actions.
- Stores response status, header digests, body sample hashes, and assertion
  outcomes; raw response body text is not persisted.
- Promotes a finding to `target-verified-issue` only when the approved
  low-impact assertion passes against the scoped target.

## Business logic validation

Use the business-logic validator for separately approved authorization,
IDOR, payment/refund/coupon, workflow-state, upload, SQL injection, and other
application-flow test cases:

```bash
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --logic-validate --execute --confirm-active --json
```

Scope requirements:

- `scope.testLevels` must include `active`.
- `scope.logicValidation.approvedBy` and
  `scope.logicValidation.approvalReference` must identify the separate
  business-logic approval.
- `scope.logicValidation.testCases` lists the only test cases that may run.
- Optional `scope.logicValidation.actorSessions` declares approved actors for
  read-only authorization checks. Actor secrets are supplied from environment
  variables and are never copied into output files.
- Actor sessions may be supplied directly with `headerEnv`, or RedScope can
  bootstrap them from a same-origin login declared on the actor. Login
  credentials must still come from environment variables; RedScope keeps
  bootstrapped headers in the current run only and stores only header digests
  and request metadata.
- For concurrent testing of multiple sites, use site-specific `headerEnv`,
  `usernameEnv`, and `passwordEnv` names in each scope file. Avoid sharing
  generic names such as `REDSCOPE_TEST_OWNER_AUTH` across two active runs unless
  both runs intentionally use the same actor session.

Direct actor header example:

```bash
REDSCOPE_TEST_OWNER_AUTH="Bearer owner-test-token" \
REDSCOPE_TEST_OTHER_AUTH="Bearer other-test-token" \
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --logic-validate --execute --confirm-active --json
```

Same-origin login bootstrap example:

```json
{
  "id": "owner-user",
  "role": "customer",
  "headerEnv": "REDSCOPE_TEST_OWNER_AUTH",
  "headerName": "Authorization",
  "login": {
    "path": "/api/login",
    "contentType": "json",
    "usernameEnv": "REDSCOPE_TEST_OWNER_USERNAME",
    "passwordEnv": "REDSCOPE_TEST_OWNER_PASSWORD",
    "usernameField": "email",
    "passwordField": "password",
    "tokenJsonPath": "data.accessToken",
    "tokenPrefix": "Bearer"
  }
}
```

If the application uses cookie sessions instead of a bearer token, omit
`tokenJsonPath`, set `headerName` to `Cookie`, and optionally set
`cookieNames` in the login block to keep only approved session cookies.
Bootstrapped token/cookie headers are not written back to the parent shell or
shared process environment, which keeps parallel site runs isolated. If login
bootstrap cannot produce a header, the validation output tells the user which
`headerEnv` or login credential variables must be provided.

Validation modes:

- `safe-readonly-http` is for IDOR and authorization checks that can be proven
  with same-origin `GET` or `HEAD`, no request body, manual redirects, and an
  approved actor matrix.
- `evidence-only` is for payment, refund, coupon, upload, SQL injection, or
  other state-changing tests where an analyst or separate approved harness
  records `observedImpact=true` plus evidence references.
- `manual-review` records a test plan and parallel lane without promoting a
  finding.

Parallel lanes:

- Test cases may set `parallelGroup` and `isolatedTestFamily`.
- Non-stateful families such as IDOR, read-only authorization, file upload
  review, and SQL injection review are emitted as independent lanes that can be
  assigned to separate analysts or subagents after confirming they do not share
  target state.
- Stateful families such as payment, refund, coupon, and workflow transitions
  are marked serial and manually supervised.

Promotion behavior:

- Writes `raw/business-logic-validation.json` with actor digests, request
  metadata, manual evidence references, parallel lanes, and policy metadata.
- Does not store raw response bodies, cookies, bearer tokens, or actor session
  header values.
- Does not execute arbitrary PoC code, fuzz payloads, payment captures,
  destructive uploads, or raw SQL injection payloads by default.
- Promotes to `target-verified-issue` only when a safe read-only actor check
  proves impact or an approved evidence-only case includes `observedImpact=true`
  and evidence references.

## Stateful business logic validation

Use the stateful validator only when the project owner explicitly approves
state-changing tests such as payment/refund/coupon/workflow-state, upload
validation, SQL injection evidence, or related business-flow mutations:

```bash
bun run redscope:command -- https://www.example.com/ --scope tools/scope.json --stateful-logic-validate --execute --confirm-active --json
```

Additional scope requirements:

- `scope.testLevels` must include `active`.
- `scope.logicValidation.stateChangingApproval.approvedBy`,
  `approvalReference`, `changeWindow`, and `rollbackPlan` must be present.
- Test cases that may execute must set
  `validationMode: "approved-state-changing-http"`.
- Each executed case sends at most one fixed same-origin `POST`, `PUT`,
  `PATCH`, or `DELETE` request using either reviewed `requestBody` data from
  the scope file or an approved `requestBodyEnv` value.
- `logicValidation.stateChangingApproval.maxMutatingRequests` defaults to `1`
  if omitted, so a run does not unexpectedly execute a batch of mutations.
- Actor sessions use the same `headerEnv` or same-origin login bootstrap
  mechanism as read-only business-logic validation.
- Raw request bodies, response bodies, cookies, bearer tokens, and actor header
  values are not persisted; RedScope stores only digests and status metadata.

Minimal stateful test-case shape:

```json
{
  "id": "coupon-replay-fixed-request",
  "title": "Other customer cannot apply owner-only coupon",
  "category": "coupon-abuse",
  "validationMode": "approved-state-changing-http",
  "target": "https://www.example.com/",
  "path": "/api/cart/coupons",
  "method": "POST",
  "testActor": "other-user",
  "objectOwnerActor": "owner-user",
  "requestContentType": "json",
  "requestBody": {
    "coupon": "OWNER_APPROVED_TEST_COUPON"
  },
  "expectedDeniedStatuses": [401, 403, 404, 409, 422],
  "vulnerableStatuses": [200, 201, 202, 204],
  "preconditionEvidenceRefs": ["ticket://approved-test-cart"],
  "observedImpact": false,
  "evidenceRefs": [],
  "rollbackPlan": "Remove the coupon from the approved test cart after the run."
}
```

Promotion behavior:

- A successful HTTP status by itself is not enough to promote a finding.
- The test case must also set `observedImpact=true` and include approved
  `evidenceRefs` that show the target-side state change or injection impact.
- Without those postcondition evidence references, the run records request
  metadata as `not-verified`.
- The runner does not generate fuzz payloads, execute public PoC code, perform
  credential attacks, capture payments, or run destructive uploads.

Report behavior:

- Every normalized finding includes a `testProcess` array in `findings.json`.
- `report.md` renders a Test Process section for every finding.
- Screenshot files placed under `raw/screenshots/` are indexed as evidence and
  rendered in finding details.

## Threat trace artifact profile

Use the artifact profile for local logs, IOC lists, SIEM exports, STIX bundles,
EVTX files, PE files, registry hives, ZIP/case bundles, and incident evidence
that has been explicitly listed in `scope.targets.artifacts`:

```bash
bun run redscope:command -- --artifact tools/artifacts/example-incident.txt --scope tools/scope.json --execute --json
```

Artifact profile guarantees:

- Reads only project-local artifact paths that are present in scope.
- Does not touch network targets or external tools.
- Requires `--execute` before local artifact contents are summarized.
- Writes `raw/artifact-summary.json` with file metadata, hashes, indicator
  counts, capped indicator samples, timestamp bounds, keyword-hit counts, and
  structured parser summaries.
- Parses supported structured evidence locally:
  - SIEM-style CSV: row counts, detected column groups, severity/event/product
    counts.
  - JSON/JSONL events: event counts, field counts, timestamp/severity/event
    hints.
  - STIX JSON bundles and TAXII collection metadata: object/collection counts,
    relationship counts, pattern/media-type counts, and pagination hints.
  - ZIP/case bundles: central-directory manifest counts without extraction.
  - Windows EVTX files: file-header, bounded chunk-header metadata, and
    bounded event-record header metadata, including version, declared chunk
    counts, sampled chunk counts, record number/identifier bounds, event
    record size bounds, event record timestamp ranges, bounded BinXML token
    counts, substitution counts, template-instance counts, and template
    identifier digests. EVTX BinXML event bodies are not decoded or copied into
    report content.
  - PCAP/PCAPNG captures: global-header metadata and bounded packet-header
    samples only. Classic PCAP Ethernet/IP/TCP/UDP headers produce protocol
    counts, byte totals, timestamp bounds, port counts, TCP flag counts, and
    anonymous flow hashes. PCAPNG files also produce section/interface/block
    counts, option-count metadata, interface link-type counts, timestamp
    resolution counts, and bounded packet-header flow metadata for supported
    enhanced/simple packet blocks. Packet payloads and raw endpoint addresses
    are not decoded or copied into reports.
  - Windows PE files: DOS/COFF/optional-header metadata, machine/subsystem
    counts, section characteristic counts, import/certificate directory
    presence, timestamp bounds, and section-name digests. Raw executable bytes,
    import names, resources, strings, code, and section names are not copied.
  - Windows registry hives: `regf` base-block metadata, sequence mismatch
    flags, last-written bounds, version/type/format counts, root-cell offset,
    hbin header counts, hbin byte totals, and embedded filename digests. Raw
    key names, values, security descriptors, and registry cells are not decoded
    or copied.
  - EML/mail header artifacts: sender/recipient domain counts, received-hop
    counts, authentication-result presence, and attachment part metadata
    counts. Attachment summaries record disposition, content type, and filename
    extension counts only; message bodies, attachment bodies, and raw
    attachment filenames are not copied.
  - Case manifests: stricter metadata validation for evidence identifiers,
    hashes, paths, timestamps, source/custodian metadata, duplicate IDs,
    path reference shape, chain-of-custody, owner, timeline, and
    scope/authorization references.
- Does not copy raw log lines, payloads, secrets, or full file contents into
  `findings.json`, `report.md`, or memory.
- Report findings remain defensive triage leads until an analyst validates them
  against trusted telemetry.

Recommended future layout:

```text
tools/
  artifacts/           local logs, IOCs, and incident evidence listed in scope
  bin/                 downloaded executables
  cache/               release archives
  manifests/           version and checksum records
  memory/              local run summaries and reusable lessons
  outputs/             tool outputs for authorized runs
  sources/             quarantined PoC/template source repositories
  redscope-tool-registry.json
  redscope-source-registry.json
  redscope-run-profiles.json
  authorized-scope.example.json
```

Risk levels:

- `reference`: architecture or workflow reference; not executed.
- `passive`: public information gathering, no direct target probing at scale.
- `baseline`: low-impact target fetches or configuration review.
- `active`: scanners, fuzzers, crawlers, or DAST tools; require explicit scope.
- `restricted`: disabled by default; needs a separate written run profile.
