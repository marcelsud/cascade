# Core runtime

## Purpose

- Defines shared message/component types and turns validated YAML into a resource-safe Effect pipeline.

## Ownership

- `config-schema.ts` owns configuration shape and validation; `config-loader.ts` owns reading, interpolation, parsing, and decode errors.
- `component-registry.ts` owns scoped custom registration; `pipeline-builder.ts` resolves built-ins and registry entries.
- `pipeline.ts` and `processor-chain.ts` own execution, cardinality, backpressure, acknowledgements, shutdown, and lifecycle ordering.
- `dlq.ts`, `errors.ts`, `metrics.ts`, and Redis helpers own cross-component operational behavior.

## Local Contracts

- Each component record selects exactly one component; unknown or ambiguous selections fail with actionable typed errors.
- Registered factories may fail synchronously or in Effect; both paths surface as `BuildError`, never defects.
- Source acknowledgement runs only after all processor and output work succeeds.
- `pipeline.output` is the sole lifecycle owner for wrapped primary and DLQ outputs; observation handles are never closed separately.
- Destructive inputs use `shutdownMode: "finish-current"`; other inputs default to interruptible intake.
- Backpressure permits cover primary send attempts, not retry delay or DLQ routing.
- Pipeline diagnostic samples remain bounded; exact totals come from stats and omission counters.

## Work Guidance

- Extend existing schema, builder, and registry routes instead of adding a second configuration path.
- Preserve error categories, shutdown outcomes, close ordering, and metrics when changing execution flow.
- Public config changes require matching docs and regression coverage.

## Verification

- `npx vitest run tests/unit/core`
- `npm run lint`
- `npm run build`

## Child DOX Index

- None.
