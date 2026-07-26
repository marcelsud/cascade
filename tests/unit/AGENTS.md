# Unit tests

## Purpose

- Provides fast, deterministic Vitest coverage for CLI, core, inputs, processors, outputs, and testing utilities.

## Ownership

- Directories mirror `src` ownership; root files cover CLI seams and registry loading.
- `inputs/__fixtures__` contains purpose-built process fixtures used by input lifecycle tests.

## Local Contracts

- Vitest uses Node, global APIs, ten-second test/hook timeouts, and excludes `tests/e2e`.
- Mock only the external boundary needed to expose behavior; use real shared helpers and Effect execution paths.
- Lifecycle tests prove cleanup and failure propagation, not only happy-path values.
- Keep regression cases adjacent to the corresponding source domain.

## Work Guidance

- Run the narrowest directory or file during iteration, then the repository unit command before delivery.

## Verification

- `npx vitest run tests/unit/<domain-or-file>`
- `npm run test:unit`

## Child DOX Index

- None.
