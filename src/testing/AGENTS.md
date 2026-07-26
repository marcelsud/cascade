# Testing utilities

## Purpose

- Provides public generate, capture, and assert components plus the declarative YAML test runner.

## Ownership

- `generate-input.ts`, `capture-output.ts`, and `assert-processor.ts` own reusable isolation fixtures.
- `test-file-parser.ts`, `yaml-test-runner.ts`, and `assertions.ts` own the YAML DSL, execution, matching, and results.
- `index.ts` owns public testing exports.

## Local Contracts

- Generate placeholders produce valid core messages and retain documented behavior.
- Capture remains bounded and observable after pipeline close.
- Assert configurations require an effective check; vacuous assertions and expected-error matchers fail closed.
- The YAML runner uses the same core schema, builder, pipeline, DLQ, and lifecycle paths as production configuration.
- Error matching handles typed failures and defects without losing actionable tags or messages.

## Work Guidance

- Prefer these utilities for component isolation instead of N-by-N combinations.
- DSL changes require parser, execution, assertion, fixture, and `docs/TESTING.md` updates as applicable.

## Verification

- `npx vitest run tests/unit/testing`
- `npm run run-pipeline -- test "tests/yaml/**/*.yaml"`
- `npm run lint`

## Child DOX Index

- None.
