## Context

The project is currently published as `effect-connect` on npm, with a CLI binary of the same name. All source code, documentation (14 files), config examples (4 files), and Docker container names reference "effect-connect" or "Effect Connect". The `package.json` exposes library fields (`main`, `types`, `exports`, `files`, `keywords`) and an npm `bin` entry.

The goal is to rebrand to "Cascade" and switch from npm distribution to a self-contained Bun-compiled binary.

## Goals / Non-Goals

**Goals:**
- Replace every user-visible occurrence of "effect-connect" / "Effect Connect" with "cascade" / "Cascade"
- Remove npm publishing fields from `package.json` (the package will no longer be distributed as an npm library)
- Add a `build:binary` script that produces a standalone binary via `bun build --compile`
- Keep TypeScript compilation (`npm run build`) for type checking and development
- Keep all existing tests passing with zero reference to the old name

**Non-Goals:**
- Renaming the GitHub repository (manual follow-up)
- Setting up GitHub Actions for multi-platform release builds
- Creating a Homebrew formula
- Renaming the local directory on disk
- Changing any runtime behavior or pipeline logic

## Decisions

### 1. Binary build tool: Bun

**Choice**: `bun build src/cli.ts --compile --outfile dist/cascade`

**Rationale**: Bun's `--compile` flag produces a single self-contained executable with no Node.js dependency. It supports TypeScript natively, so the existing source compiles directly. Alternatives considered:
- **pkg (Vercel)**: Deprecated, no longer maintained.
- **nexe**: Less active, larger output binaries.
- **esbuild + sea (Node SEA)**: Requires Node 20+ and multi-step build process. More complex than Bun's single command.

**Trade-off**: Adds Bun as a build-time dependency. Developers need both Node (for tests/type-checking) and Bun (for binary builds).

### 2. Keep `package.json` for development tooling

**Choice**: Retain `package.json` with `name: "cascade"` but strip all npm publishing fields.

**Rationale**: The project still uses npm for dependency management, vitest for testing, and tsc for type checking. Removing `package.json` entirely would break the dev workflow. Removing only the publishing-specific fields (`main`, `types`, `exports`, `files`, `keywords`, `bin`, `prepublishOnly`) clearly signals this is no longer an npm library.

### 3. Execution order: source first, docs last

**Choice**: Modify source files and `package.json` first, then docs, then configs, then Docker.

**Rationale**: Source changes are verifiable with `npm run build` and `npm run test:unit`. Docs and configs are cosmetic renames. Doing source first means we can verify correctness before bulk-renaming documentation.

### 4. Version reading from package.json

**Choice**: Keep the existing pattern in `src/cli.ts` that reads version from `../package.json` at runtime.

**Rationale**: The Bun-compiled binary bundles the `package.json` read at compile time, so the version is baked into the binary. No code change needed — just ensure `package.json` version is correct before building.

### 5. Description wording

**Choice**: Remove "powered by Effect.js" from description. New description: "Declarative streaming library inspired by Apache Camel and Benthos".

**Rationale**: The rebrand intentionally decouples the user-facing identity from the runtime technology. Effect.js remains the implementation choice but doesn't need to be in the tagline.

## Risks / Trade-offs

- **Bun build compatibility** → Bun's `--compile` must handle all dependencies (Effect.js, ioredis, AWS SDK). Mitigation: verify binary runs after build (`./dist/cascade --version`).
- **Missed occurrences** → A stale "effect-connect" reference could survive in a file. Mitigation: final verification step with `grep -ri "effect.connect" src/ docs/ configs/ package.json docker-compose.yml` must return zero hits.
- **Binary size** → Bun-compiled binaries bundle the runtime and all dependencies, which may be large. Mitigation: acceptable for CLI distribution; size optimization is a future concern.
- **Developer confusion** → Two build commands (`npm run build` for tsc, `npm run build:binary` for Bun). Mitigation: clear naming and documentation.
- **No automated releases yet** → Binary must be built manually until GitHub Actions pipeline is set up. Mitigation: documented as out of scope; manual `bun build` works for now.
