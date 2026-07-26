# Processors

## Purpose

- Transforms, filters, enriches, fans out, and routes messages within a pipeline.

## Ownership

- Each `*-processor.ts` owns its configuration and transformation behavior.
- Nested branch and switch execution composes through `src/core/processor-chain.ts`.

## Local Contracts

- A processor returns `Message` or `Message[]` in Effect; an empty array suppresses and arrays preserve fan-out cardinality.
- Never mutate input messages or metadata/content in place.
- Branch preserves the original and stores processed results in metadata; switch preserves configured routing order and case semantics.
- Expression, HTTP, and sandbox failures remain typed and do not escape as unhandled defects.
- Validation rejects empty or ineffective configurations at build time.

## Work Guidance

- Reuse JSONata, core validation, processor-chain, and error helpers.
- Processor changes require core schema/builder registration, appropriate public export, focused tests, YAML-path proof, and `docs/processors` updates.

## Verification

- `npx vitest run tests/unit/processors`
- Run focused YAML or E2E tests for nested routing and external HTTP behavior.
- `npm run lint`

## Child DOX Index

- None.
