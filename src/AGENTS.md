# Source tree

## Purpose

- Implements Cascade's public API, CLI, pipeline runtime, components, and reusable testing utilities.

## Ownership

- Root-level `cli*.ts` files own argument parsing, configuration, dispatch, diagnostics, metrics, and the executable entrypoint.
- `index.ts` owns the supported library export surface.
- Child Dox files own core orchestration, component families, and testing utilities.

## Local Contracts

- Keep ESM imports explicit with `.js` extensions.
- Keep Effect failures in typed error channels; convert defects or synchronous constructor throws at trust boundaries.
- Preserve immutable `Message` values and Effect-managed resource cleanup.
- Add intended public APIs to `index.ts`; keep internal helpers unexported.
- Keep CLI branching in focused helpers so `cli.ts` remains the Effect composition entrypoint.

## Work Guidance

- Reuse core types, validation helpers, error categories, metrics accumulators, and Redis helpers before adding parallel utilities.
- Public configuration or component changes require schema/build wiring, behavioral tests, and user documentation.

## Verification

- `npm run lint`
- `npm run build`
- Run focused Vitest files for changed source paths.

## Child DOX Index

- `core/AGENTS.md` — pipeline contracts, configuration, registry, errors, DLQ, metrics, and shared infrastructure.
- `inputs/AGENTS.md` — streaming sources and intake lifecycle.
- `outputs/AGENTS.md` — delivery destinations and output lifecycle.
- `processors/AGENTS.md` — message transformations and routing.
- `testing/AGENTS.md` — public test components and YAML test runner.
