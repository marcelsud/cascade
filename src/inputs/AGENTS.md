# Inputs

## Purpose

- Adapts HTTP, files, standard input, SQS, and Redis sources into backpressured `Stream<Message>` values.

## Ownership

- Each `*-input.ts` owns source configuration, validation, message conversion, metrics, errors, and cleanup.
- `input-queue.ts` owns bounded overflow behavior; `redis-reconnect.ts` owns shared reconnect policy; `text-input-utils.ts` owns text decoding.

## Local Contracts

- Inputs return a stable name, stream, optional close, metrics, and correct shutdown mode.
- Sources that remove or advance data before delivery attach an idempotent `ack` when supported and finish active destructive pulls during graceful shutdown.
- Queue size and `block`, `drop_new`, or `drop_old` behavior stay bounded and reflected in metrics.
- HTTP request bodies are bounded by a configured byte limit enforced before buffering; oversized requests are rejected without becoming messages.
- Acquisition and release remain cancellation-safe; close never leaks source handles.
- Failures retain the project's fatal, intermittent, and logical categories.
- File one-shot (`follow: false`): clean EOF completes the stream successfully after drain; a terminal open/stat/read failure drains accepted records first, then fails the stream with `FileInputError` (counted once in input metrics). Follow mode retains retry/rotation and does not use that terminal path.

## Work Guidance

- Reuse shared Redis connection/options and queue helpers.
- Input changes require core schema/builder wiring, public export when supported, focused tests, YAML-path proof, and `docs/inputs` updates.

## Verification

- `npx vitest run tests/unit/inputs`
- Run focused E2E coverage for delivery, acknowledgement, reconnection, or real source lifecycle changes.
- `npm run lint`

## Child DOX Index

- None.
