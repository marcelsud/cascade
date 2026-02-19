## 1. Package Configuration

- [x] 1.1 Rename `package.json` `name` from `effect-connect` to `cascade`
- [x] 1.2 Update `package.json` `description` to "Declarative streaming library inspired by Apache Camel and Benthos"
- [x] 1.3 Remove npm publishing fields from `package.json`: `main`, `types`, `exports`, `files`, `keywords`, `bin`
- [x] 1.4 Remove `prepublishOnly` script from `package.json`
- [x] 1.5 Add `build:binary` script: `bun build src/cli.ts --compile --outfile dist/cascade`

## 2. Source Code Rebrand

- [x] 2.1 Replace all 11 occurrences of `effect-connect` with `cascade` in `src/cli.ts` (program name, version, help text, usage examples, error messages)
- [x] 2.2 Update description in `src/cli.ts` help text to remove "powered by Effect.js"
- [x] 2.3 Update User-Agent header in `src/outputs/http-output.ts` from `effect-connect/<version>` to `cascade/<version>`
- [x] 2.4 Update comment header in `src/testing/index.ts` from "Effect Connect" to "Cascade"

## 3. Verification — Source

- [x] 3.1 Run `npm run build` and verify TypeScript compiles without errors
- [x] 3.2 Run `npm run test:unit` and verify all tests pass

## 4. Documentation

- [x] 4.1 Update `README.md` — rename title, remove npm badge, replace all `effect-connect` references with `cascade`, replace npm install instructions with binary download, update or remove library import examples
- [x] 4.2 Update `CLAUDE.md` — replace all `effect-connect` / "Effect Connect" references with `cascade` / "Cascade"
- [x] 4.3 Update `docs/README.md` — replace all old name references
- [x] 4.4 Update `docs/TESTING.md` — replace all old name references
- [x] 4.5 Update `docs/advanced/bloblang.md` — replace all old name references
- [x] 4.6 Update `docs/inputs/http.md` — replace all old name references
- [x] 4.7 Update `docs/outputs/http.md` — replace all old name references
- [x] 4.8 Update `docs/processors/http.md` — replace all old name references
- [x] 4.9 Update `docs/processors/dedupe.md` — replace all old name references
- [x] 4.10 Update `docs/spec/COMPONENTS.md` — replace all old name references
- [x] 4.11 Update `docs/local-development.md` — replace all old name references
- [x] 4.12 Update `tests/e2e/README.md` — replace all old name references
- [x] 4.13 Update `tests/e2e/run-all-tests.sh` — replace all old name references

## 5. Config Examples

- [x] 5.1 Update `configs/http-webhook-example.yaml` — replace CLI commands and headers
- [x] 5.2 Update `configs/dedupe-example.yaml` — replace CLI commands and headers
- [x] 5.3 Update `configs/dedupe-metadata-example.yaml` — replace CLI commands
- [x] 5.4 Update `configs/dedupe-sqs-example.yaml` — replace CLI commands

## 6. Docker

- [x] 6.1 Rename all `container_name` values in `docker-compose.yml` from `effect-connect-*` to `cascade-*`

## 7. OpenSpec

- [x] 7.1 Update `openspec/changes/add-dedupe-processor/design.md` — replace old name references

## 8. Final Verification

- [x] 8.1 Run `npm run build` — TypeScript compiles
- [x] 8.2 Run `npm run test:unit` — all tests pass
- [x] 8.3 Run `bun build src/cli.ts --compile --outfile dist/cascade` — binary compiles
- [x] 8.4 Run `./dist/cascade --version` — binary runs and shows correct version
- [x] 8.5 Run case-insensitive grep for "effect.connect" across `src/`, `docs/`, `configs/`, `package.json`, `docker-compose.yml`, `README.md`, `CLAUDE.md`, `tests/` — zero hits
