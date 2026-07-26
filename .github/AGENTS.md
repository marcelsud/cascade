# GitHub automation and grading

## Purpose

- Defines CI, contribution templates, graded-issue intake, and repository quality ratchets.

## Ownership

- `workflows/ci.yml` owns pull-request and main-branch checks.
- `grading/config.yml` owns rubric objectives, baselines, thresholds, exclusions, and enforcement modes.
- `grading/checks.mjs` and its tests own executable grading checks.
- Issue and PR templates own required contribution metadata.

## Local Contracts

- Threshold, exclusion, baseline, or grading-mode changes are policy changes and require their own reviewed PR.
- Blocking ratchets fail closed; report-only complexity, duplication, and coverage checks remain visible without blocking.
- CI installs from the frozen Bun lockfile and runs unused-code, grading-tool, type, build, integrity, and unit checks.
- Test-integrity changes preserve detection of focused, skipped, ignored, or collection-reducing tests.

## Work Guidance

- Update executable checks and their Node test coverage together.
- Keep workflow commands synchronized with package scripts and grading configuration.

## Verification

- `node --test .github/grading/checks.test.mjs`
- Run the affected `node .github/grading/checks.mjs <command>` invocation.
- Review the CI workflow for least privilege and deterministic inputs.

## Child DOX Index

- None.
