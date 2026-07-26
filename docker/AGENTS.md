# Local Docker infrastructure

## Purpose

- Provides shared Redis and LocalStack services for local Cascade development.

## Ownership

- `docker-compose.yml` defines services; initialization scripts create local SQS resources.
- Repository-root `docker-compose.yml` is the user-facing entrypoint and remains governed by the root Dox file.

## Local Contracts

- Services use development-only data, stable ports, and health checks suitable for documented local workflows.
- Initialization scripts are repeatable and fail visibly when required setup cannot be created.
- This infrastructure is separate from scenario-owned `tests/e2e/infrastructure`.

## Work Guidance

- Keep image, port, credential, and resource-name changes synchronized with local-development docs and affected tests.

## Verification

- `npm run docker:up`
- `npm run docker:ps`
- `npm run docker:down`

## Child DOX Index

- None.
