# GitHub automation and grading

## Purpose

- Defines CI, contribution templates, graded-issue intake, and repository quality ratchets.

## Ownership

- `workflows/ci.yml` owns pull-request and main-branch checks.
- `grading/config.yml` is the project configuration artifact required by grading-methodology §4.7. It owns the objective registry, the continuous-audit topic registry, baselines, thresholds, exclusions, and enforcement modes.
- `grading/checks.mjs` and its tests own executable grading checks.
- `grading/audit.mjs` and its tests own continuous-audit topic selection and ledger access. Selection is pure and reproducible from (ledger, commit, seed); no model runs inside it.
- `grading/audit-run.mjs` and its tests own the agent-driven run lifecycle: `start`, `check`, `file`, `drop`, `finish`. The agent decides what to claim; this tool decides what leaves the machine.
- `grading/calibration.mjs` and its tests own empirical authority for one exact model, prompt, toolchain, and topic tuple. Calibration data is controller-signed and remains outside the repository.
- Issue and PR templates own required contribution metadata.

## Local Contracts

- Threshold, exclusion, baseline, objective, topic, or grading-mode changes are policy changes and require their own reviewed PR.
- Objective identifiers are stable and are never reused for a different guarantee; stored grade records cite them.
- Every audit topic cites an objective present in the registry, and every declared topic path exists. Both are asserted by `audit.test.mjs`.
- The `grading-ledger` branch is append-only data: no source, no CI, never merged into `main`. A failed run records `outcome: failed` and leaves its topic's staleness intact.
- A candidate declares Vitest files and expected failure text, never a shell command. The tool creates a frozen, script-disabled install at the audited commit and accepts only a named failing assertion from Vitest's structured report. It persists test contents, hashes, assertion output, and runner/lockfile identity.
- `file` is bound to the exact checked candidate body and audited commit. A completed run requires a structured inspection report whose contract IDs, topic paths, and behavior-cell evidence lines validate against that commit. Prose-only, dirty-start, and changed-HEAD runs fail closed.
- Calibration records require an HMAC from a controller key outside the repository. Authority uses configured minimum case counts and one-sided confidence lower bounds; model self-confidence is never evidence.
- Run state lives in `.git/continuous-audit-run.json`: untracked, and an abandoned run is recorded as failed by the next `start`.
- Blocking ratchets fail closed; report-only complexity, duplication, and coverage checks remain visible without blocking.
- CI installs from the frozen Bun lockfile and runs unused-code, grading-tool, type, build, integrity, and unit checks.
- Test-integrity changes preserve detection of focused, skipped, ignored, or collection-reducing tests.
- SonarQube Community Build analysis is local-only: generate `coverage/lcov.info`, then run `sonar-scanner` from the repository root against a locally configured instance.

## Work Guidance

- Update executable checks and their Node test coverage together.
- Keep workflow commands synchronized with package scripts and grading configuration.
- Keep `sonar-project.properties` and Vitest coverage scopes synchronized.

## Verification

- `node --test .github/grading/checks.test.mjs`
- `node --test .github/grading/audit.test.mjs .github/grading/audit-run.test.mjs`
- `node --test .github/grading/calibration.test.mjs`
- `node .github/grading/calibration.mjs evaluate <signed-results.jsonl> --key-file <external-key> [--require-qualified]`
- Run the affected `node .github/grading/checks.mjs <command>` invocation.
- `node .github/grading/audit.mjs coverage` to inspect topic staleness and churn; `select [--seed <n>]` to pick or replay a run's topic.
- Review the CI workflow for least privilege and deterministic inputs.
- `npm run test:coverage` must create `coverage/lcov.info`.
- Run `sonar-scanner` from the repository root against a configured Community Build instance.

## Child DOX Index

- None.
