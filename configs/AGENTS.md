# Example configurations

## Purpose

- Provides runnable YAML examples for common Cascade pipelines and advanced features.

## Ownership

- Each file demonstrates one coherent user workflow using built-in components.

## Local Contracts

- Examples decode with the current root configuration schema and select exactly one input and output component.
- Use documented snake_case keys and safe placeholder endpoints, credentials, queues, streams, and paths.
- Keep examples understandable without hidden setup; reference required Redis, SQS, HTTP, or filesystem prerequisites.
- Never commit real secrets or production identifiers.

## Work Guidance

- Update or add an example when a public feature needs executable discovery beyond its reference page.

## Verification

- `npm run run-pipeline -- validate configs/<file>.yaml`

## Child DOX Index

- None.
