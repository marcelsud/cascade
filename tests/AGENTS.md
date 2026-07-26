# Tests

## Purpose

- Proves source behavior through fast unit tests, declarative YAML scenarios, and selective real-infrastructure E2E tests.

## Ownership

- `unit` mirrors source domains and owns isolated Vitest regression coverage.
- `yaml` owns declarative pipeline fixtures exercised by the public YAML test runner.
- `e2e` owns real process, network, Redis, SQS, HTTP, and lifecycle scenarios.

## Local Contracts

- A behavior change leaves the smallest regression proof that fails on the prior behavior.
- Do not use focused, skipped, todo, or conditionally hidden tests except the explicitly approved grading baseline.
- Prefer component isolation with generate/assert/capture utilities; reserve E2E for cross-boundary guarantees.
- Tests must clean up timers, processes, ports, files, clients, and containers they create.

## Work Guidance

- Keep test paths aligned with the source subtree they cover.
- Assert externally meaningful behavior and error categories, not private implementation trivia.

## Verification

- `npm run test:unit`
- `node .github/grading/checks.mjs test-integrity --base origin/main`

## Child DOX Index

- `unit/AGENTS.md` — isolated Vitest suites.
- `e2e/AGENTS.md` — real infrastructure and process-level scenarios.
