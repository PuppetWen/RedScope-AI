# BASH_CLASSIFIER - Bash Command Classifier

> Feature flag: `FEATURE_BASH_CLASSIFIER=1`
> Current RedScope status: intentionally disabled in external builds.

## Decision

RedScope keeps the semantic Bash prompt classifier disabled for external
builds. The original adapter was an internal Anthropic-only integration, and
restoring it would add an LLM decision path that can auto-approve shell
commands. For the security-suite track, the safer boundary is deterministic:
Bash and PowerShell permissions continue to rely on local rule matching,
read-only validators, path constraints, destructive-command checks, and
explicit user approval.

This means `src/utils/permissions/bashClassifier.ts` remains a compatibility
shim:

- `isClassifierPermissionsEnabled()` always returns `false`.
- Bash prompt allow/ask/deny description getters return empty arrays.
- `classifyBashCommand()` returns a high-confidence no-match result with a
  stable disabled reason.
- `generateGenericDescription()` only preserves an explicit description; it
  does not call a model to synthesize one.

## Permission Flow

The active permission path is:

```text
Bash command
  -> exact/prefix permission rules
  -> deny and ask rules
  -> path and syntax safety checks
  -> deterministic read-only validation
  -> explicit permission prompt when safety cannot be proven
```

The classifier UI and plumbing remain in place for compatibility with existing
feature gates, but the RedScope external shim does not produce auto-approval
decisions.

## Compatibility Boundary

Keep these names and call sites unless a dedicated migration is planned:

- `FEATURE_BASH_CLASSIFIER`
- `bash_classifier` beta header wiring
- `BashPermissionRequest` classifier display fields
- `classifierApprovals` storage used by other classifier paths

Do not replace this shim with a semantic LLM classifier until there is a
separate threat model, offline fallback, prompt-injection analysis, and
end-to-end permission regression suite.

## Verification

```bash
bun test src/utils/permissions/__tests__/bashClassifier.test.ts
bun run typecheck
```
