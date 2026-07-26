# GitHub automation and grading

## Purpose

- Defines CI, contribution templates, graded-issue intake, and repository quality ratchets.

## Ownership

- `workflows/ci.yml` owns pull-request and main-branch checks.
- `grading/config.yml` is the project configuration artifact required by grading-methodology §4.7. It owns the objective registry, the continuous-audit topic registry, baselines, thresholds, exclusions, and enforcement modes.
- `grading/checks.mjs` and its tests own executable grading checks.
- `grading/audit.mjs` and its tests own continuous-audit topic selection and ledger access. Selection is pure and reproducible from (ledger, commit, seed); no model runs inside it.
- Issue and PR templates own required contribution metadata.

## Local Contracts

- Threshold, exclusion, baseline, objective, topic, or grading-mode changes are policy changes and require their own reviewed PR.
- Objective identifiers are stable and are never reused for a different guarantee; stored grade records cite them.
- Every audit topic cites an objective present in the registry, and every declared topic path exists. Both are asserted by `audit.test.mjs`.
- The `grading-ledger` branch is append-only data: no source, no CI, never merged into `main`. A failed run records `outcome: failed` and leaves its topic's staleness intact.
- Blocking ratchets fail closed; report-only complexity, duplication, and coverage checks remain visible without blocking.
- CI installs from the frozen Bun lockfile and runs unused-code, grading-tool, type, build, integrity, and unit checks.
- Test-integrity changes preserve detection of focused, skipped, ignored, or collection-reducing tests.

## Work Guidance

- Update executable checks and their Node test coverage together.
- Keep workflow commands synchronized with package scripts and grading configuration.

## Verification

- `node --test .github/grading/checks.test.mjs`
- `node --test .github/grading/audit.test.mjs`
- Run the affected `node .github/grading/checks.mjs <command>` invocation.
- `node .github/grading/audit.mjs coverage` to inspect topic staleness and churn; `select [--seed <n>]` to pick or replay a run's topic.
- Review the CI workflow for least privilege and deterministic inputs.

## Child DOX Index

- None.
