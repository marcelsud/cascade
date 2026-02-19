## ADDED Requirements

### Requirement: Binary build via Bun
The build system SHALL produce a standalone executable binary by compiling `src/cli.ts` with `bun build --compile`. The binary SHALL be output to `dist/cascade`. The `package.json` SHALL include a `build:binary` script that runs `bun build src/cli.ts --compile --outfile dist/cascade`.

#### Scenario: Build binary from source
- **WHEN** the developer runs `npm run build:binary`
- **THEN** a standalone executable is created at `dist/cascade`

#### Scenario: Binary runs without Node.js
- **WHEN** the compiled binary `dist/cascade` is executed with `--version`
- **THEN** it outputs the version string `cascade v<version>` without requiring a Node.js installation

### Requirement: Remove npm publishing fields
The `package.json` SHALL NOT contain the fields `main`, `types`, `exports`, `files`, `keywords`, `bin`, or `prepublishOnly` script. The package SHALL NOT be published to npm.

#### Scenario: package.json has no library fields
- **WHEN** the contents of `package.json` are inspected
- **THEN** the fields `main`, `types`, `exports`, `files`, `keywords`, and `bin` are absent

#### Scenario: No prepublishOnly hook
- **WHEN** the `scripts` section of `package.json` is inspected
- **THEN** there is no `prepublishOnly` script

### Requirement: Package renamed to cascade
The `package.json` `name` field SHALL be `cascade`. The `description` field SHALL NOT contain "powered by Effect.js". The description SHALL read "Declarative streaming library inspired by Apache Camel and Benthos".

#### Scenario: Package name is cascade
- **WHEN** the `name` field in `package.json` is read
- **THEN** its value is `cascade`

#### Scenario: Description omits Effect.js
- **WHEN** the `description` field in `package.json` is read
- **THEN** it does not contain "powered by Effect.js"
- **THEN** it reads "Declarative streaming library inspired by Apache Camel and Benthos"

### Requirement: CLI binary branded as cascade
All user-facing text in `src/cli.ts` SHALL reference "cascade" instead of "effect-connect". This includes the program name, version output, help text, usage examples, and error messages.

#### Scenario: Help text shows cascade branding
- **WHEN** the user runs `cascade --help`
- **THEN** the output shows "cascade v<version>" as the header
- **THEN** all usage examples use `cascade` as the command name
- **THEN** the description reads "Declarative streaming library inspired by Apache Camel and Benthos"

#### Scenario: Version output shows cascade
- **WHEN** the user runs `cascade --version`
- **THEN** the output is `cascade v<version>`

#### Scenario: Error messages reference cascade
- **WHEN** the user provides an unknown command
- **THEN** the error message suggests running `cascade --help`

### Requirement: User-Agent header uses cascade
The HTTP output component SHALL send `cascade/<version>` as the User-Agent header instead of `effect-connect/<version>`.

#### Scenario: HTTP output User-Agent
- **WHEN** the HTTP output sends a request
- **THEN** the `User-Agent` header value is `cascade/<version>`

### Requirement: Docker containers renamed
All `container_name` values in `docker-compose.yml` SHALL use the prefix `cascade-` instead of `effect-connect-`.

#### Scenario: Docker container names
- **WHEN** `docker-compose.yml` is inspected
- **THEN** all `container_name` values start with `cascade-` and none start with `effect-connect-`

### Requirement: Documentation references updated
All markdown documentation files SHALL reference "Cascade" and `cascade` instead of "Effect Connect" and `effect-connect`. npm install instructions SHALL be replaced with binary download instructions. Import examples using `from "effect-connect"` SHALL be updated or removed.

#### Scenario: No old name in documentation
- **WHEN** a case-insensitive search for "effect-connect" or "effect connect" is run across `README.md`, `CLAUDE.md`, `docs/`, and `tests/e2e/README.md`
- **THEN** zero matches are found

#### Scenario: CLI examples in docs use cascade
- **WHEN** documentation shows CLI usage examples
- **THEN** the command name is `cascade`, not `effect-connect`

### Requirement: Config examples updated
All YAML configuration example files in `configs/` SHALL reference `cascade` in CLI commands and headers instead of `effect-connect`.

#### Scenario: No old name in config examples
- **WHEN** a case-insensitive search for "effect-connect" is run across `configs/`
- **THEN** zero matches are found

### Requirement: Source code comments updated
Comment headers and string literals in source files (`src/testing/index.ts`, `src/outputs/http-output.ts`) SHALL reference "Cascade" instead of "Effect Connect".

#### Scenario: No old name in source
- **WHEN** a case-insensitive search for "effect-connect" or "effect connect" is run across `src/`
- **THEN** zero matches are found

### Requirement: TypeScript build preserved
The existing `npm run build` (tsc) command SHALL continue to work for type checking and development. The `npm run test:unit` command SHALL pass with all existing tests.

#### Scenario: TypeScript compiles
- **WHEN** the developer runs `npm run build`
- **THEN** TypeScript compilation succeeds without errors

#### Scenario: Unit tests pass
- **WHEN** the developer runs `npm run test:unit`
- **THEN** all existing tests pass
