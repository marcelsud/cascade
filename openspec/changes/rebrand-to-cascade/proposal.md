## Why

The project name "effect-connect" leaks an implementation detail (Effect.js) into the user-facing brand. Rebranding to **Cascade** gives the project a standalone identity that communicates its purpose (streaming data pipelines) without coupling to a specific runtime. Simultaneously, switching from npm package distribution to a compiled Bun binary simplifies installation for end users and removes the Node.js dependency.

## What Changes

- **BREAKING** — Rename package, CLI binary, and all references from `effect-connect` to `cascade`
- **BREAKING** — Remove npm library distribution (`main`, `types`, `exports`, `files`, `prepublishOnly`, `keywords`, `bin`)
- Add Bun-compiled binary build (`bun build src/cli.ts --compile --outfile dist/cascade`)
- Update `package.json` name to `cascade`, remove "powered by Effect.js" from description
- Rename CLI branding: program name, version output, help text (11 occurrences in `src/cli.ts`)
- Update User-Agent header from `effect-connect/x.x.x` to `cascade/x.x.x` in HTTP output
- Update comment headers in source files
- Rename Docker container names from `effect-connect-*` to `cascade-*`
- Bulk find-replace across 14 documentation files (README, CLAUDE.md, docs/*, tests/e2e/README)
- Update 4 config YAML examples with new CLI name and headers
- Update OpenSpec change artifacts referencing old name

## Capabilities

### New Capabilities

- `binary-distribution`: Bun-compiled standalone binary build, replacing npm package publishing as the distribution method

### Modified Capabilities

_(No existing specs to modify — this is the first set of specs for the project)_

## Impact

- **CLI**: Binary name changes from `effect-connect` to `cascade` — users must update scripts and aliases
- **Source code**: `src/cli.ts`, `src/outputs/http-output.ts`, `src/testing/index.ts`
- **Build system**: `package.json` loses npm publishing fields, gains `build:binary` script; requires Bun as build dependency
- **Documentation**: 14 markdown files need bulk rename; npm install instructions replaced with binary download
- **Config examples**: 4 YAML files reference CLI name in comments/headers
- **Docker**: `docker-compose.yml` container names change
- **Out of scope**: GitHub repo rename, GitHub Actions release pipeline, Homebrew formula
