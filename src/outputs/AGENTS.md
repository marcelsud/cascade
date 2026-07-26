# Outputs

## Purpose

- Delivers messages to HTTP, files, standard output, SQS, and Redis destinations.

## Ownership

- Each `*-output.ts` owns validation, sends, errors, metrics, and cleanup.
- `writable-output.ts` owns ordered serialization and writable lifecycle shared by file and stdout.
- `redis-output-options.ts` owns shared Redis option normalization.

## Local Contracts

- Outputs implement `send`, optional failure-aware `close`, metrics, and core backpressure binding.
- `send` resolves only when the destination accepts or flushes according to its documented guarantee.
- Close drains in-flight work and surfaces failures; borrowed streams are never ended by Cascade.
- Retry and DLQ wrapping preserve the primary output as sole lifecycle owner.
- Serialization rejects root values that cannot be represented instead of silently dropping content.

## Work Guidance

- Reuse writable coordination, Redis options, metrics, validation, and error categories.
- Output changes require core schema/builder registration, appropriate public export, focused tests, YAML-path proof, and `docs/outputs` updates.

## Verification

- `npx vitest run tests/unit/outputs`
- Run focused E2E coverage for real delivery, retry, flush, or connection lifecycle changes.
- `npm run lint`

## Child DOX Index

- None.
