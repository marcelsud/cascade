# End-to-end tests

## Purpose

- Verifies delivery, acknowledgement, reconnection, graceful drain, DLQ, and CLI behavior against real infrastructure.

## Ownership

- `run.ts` and `run-all-tests.sh` own suite entrypoints.
- `helpers` owns process, resource, wait, and infrastructure lifecycle.
- `configs` owns scenario pipelines; `infrastructure` owns Docker Compose services; `scripts` owns focused shell scenarios.

## Local Contracts

- Call `assertE2EInfrastructure` before Vitest E2E execution.
- Use allocated resources and bounded waits; never assume immediate network readiness.
- Stop spawned Cascade processes and infrastructure in cleanup paths, including failures.
- Preserve at-least-once evidence such as Redis pending entries or SQS visibility until assertions complete.
- E2E configs use the same YAML schema and CLI path as users.

## Work Guidance

- Add E2E only when unit isolation cannot prove the cross-process or external-system contract.
- Document new prerequisites and environment variables in `README.md`.

## Verification

- `npm run test:e2e`
- Use the matching `npm run e2e:<component>` script for focused legacy scenarios.

## Child DOX Index

- None.
