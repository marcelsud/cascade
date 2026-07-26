# Documentation

## Purpose

- Explains installation, component configuration, testing, extension, local development, and operational guarantees.

## Ownership

- `README.md` is the docs landing page; `TESTING.md` owns testing strategy; `component-registry.md` owns extension guidance; `local-development.md` owns local setup.
- `inputs`, `processors`, and `outputs` mirror public components.
- `advanced` owns cross-cutting runtime behavior; `spec/COMPONENTS.md` owns component-development conventions.

## Local Contracts

- Document only implemented keys, defaults, validation, side effects, delivery guarantees, and limitations.
- Keep YAML examples valid against the current schema and use snake_case configuration names.
- Public component/config changes update the matching reference and any affected README index.
- Link to canonical details instead of duplicating long contracts across pages.

## Work Guidance

- Verify claims against source schemas, builders, and behavioral tests.
- Remove stale counts, paths, and status claims when touched.

## Verification

- Validate changed YAML snippets with `cascade validate` or the TypeScript CLI.
- Check relative links and run focused behavior tests supporting changed claims.

## Child DOX Index

- None.
