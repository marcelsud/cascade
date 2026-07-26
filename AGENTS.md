# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md.

## Child DOX Index

- `.github/AGENTS.md` — CI, issue templates, PR policy, and grading ratchets.
- `configs/AGENTS.md` — runnable example pipeline configurations.
- `docker/AGENTS.md` — shared local-development infrastructure.
- `docs/AGENTS.md` — user, component, testing, and operational documentation.
- `src/AGENTS.md` — runtime, CLI, public API, components, and test utilities.
- `tests/AGENTS.md` — unit, declarative YAML, and end-to-end verification.

# Cascade - Project Guide

## Project Overview

**Cascade** is a declarative streaming library for building type-safe data pipelines using YAML configuration. It's inspired by Apache Camel and Benthos, but built with TypeScript and Effect.js for full type safety and functional programming.

- **Tech Stack**: TypeScript, Effect.js, @effect/schema, @effect/platform-node
- **Distribution**: Standalone compiled binary (`cascade`)
- **Usage**: CLI tool (standalone binary)

### Key Features
- YAML-based pipeline configuration
- Type-safe with Effect.js monads and @effect/schema validation
- HTTP input (webhook server) and output (API client) support
- Streaming with backpressure control
- Built-in Dead Letter Queue (DLQ) support
- Automatic metrics and observability
- Debug mode for troubleshooting (`--debug` flag)

## Architecture & Design

### Core Architecture
Cascade uses a **functional, type-safe architecture** powered by Effect.js:

```
Input Stream → Processor₁ → Processor₂ → Output
     ↓             ↓            ↓           ↓
Effect.Stream   Effect      Effect      Effect
```

### Key Principles
1. **Effect.js Foundation**: All operations use Effect monad for error handling and composability
2. **Stream Processing**: Inputs produce `Stream<Message>`, processors transform via `Effect<Message>`
3. **Type Safety**: Full TypeScript types with Effect.js schema validation
4. **Resource Management**: Automatic cleanup with Effect's resource management
5. **Observability**: Built-in metrics, tracing, and correlation IDs

### Project Structure
```
src/
├── core/              # Pipeline orchestration, types, config loader, DLQ
├── inputs/            # HTTP, SQS, Redis Streams
├── processors/        # Metadata, Uppercase, Mapping, Logging
├── outputs/           # HTTP, SQS, Redis Streams
├── cli.ts            # CLI entry point (bin)
└── index.ts          # Library exports
```

**Detailed component docs**: See `docs/COMPONENTS.md`

## Development Workflow

### Build & Test
```bash
# Build TypeScript to dist/
npm run build

# Run all unit tests (228 tests)
npm run test:unit

# Run E2E tests
npm run test:e2e

# Lint (TypeScript type checking)
npm run lint

# Format code
npm run format
```

### Testing Strategy
Cascade uses a scalable testing approach that avoids N×N test explosion:

- **Testing Utilities**: `createGenerateInput`, `createCaptureOutput`, `createAssertProcessor`
- **Pattern**: Test components in isolation (Input → Assert → Capture)
- **Scale**: N components = ~3N tests (not N²)
- **Speed**: All 228 tests run in < 10 seconds

**See [docs/TESTING.md](./docs/TESTING.md) for complete testing guide.**

### CLI Development
- **Binary build**: `npm run build:binary` compiles standalone binary via Bun
- **Output**: `dist/cascade` (self-contained executable)
- **Debug mode**: Use `--debug` flag to see detailed logs (`cascade run config.yaml --debug`)

### Building
```bash
# TypeScript compilation (for type checking and development)
npm run build

# Standalone binary (for distribution)
npm run build:binary
```

### Local Testing with Docker
```bash
npm run docker:up     # Start LocalStack + Redis
npm run docker:down   # Stop services
npm run docker:logs   # View logs
```

### GitHub Issue Delivery (seven-stage multi-model workflow)

For graded Cascade GitHub issues, the default done state is **end-to-end
delivery** unless the user explicitly limits scope. Do not stop after local
implementation or local verification alone.

Issue grading and ship-gate linkage live in `.github/grading/config.yml` and the
repo grading methodology. Apply the existing severity gate and two-round
convergence rules from `/home/marcelsud/.claude/CLAUDE.md` (Blocker / Material /
Cosmetic; hard cap 2 rounds per artifact). **Do not redefine severity here** —
reference and apply that canonical guidance.

**Configured model selectors (exact; no silent substitution):**

| Role | Selector |
|------|----------|
| Plan + primary local ship-gate + one independent post-PR review | `openai-codex/gpt-5.6-sol` |
| Implement + the other independent post-PR review | `grok-4.5` |

- If a required selector is unavailable, **stop and report the blocker**. Never
  silently substitute another model.
- If the active agent already is the required GPT selector, it MAY plan/review
  itself; otherwise delegate with the exact selector above.
- Shared lint, format, and project-wide checks run **once centrally** after
  implementation (or after a fix round). Subagents run focused verification
  only — not full-suite or format passes.

#### Stage 1 — Plan (`openai-codex/gpt-5.6-sol`)

1. Read the issue, `AGENTS.md`, canonical Claude instructions, relevant prior
   decisions, and affected code paths.
2. Reproduce the bug or establish pre-change behavior when the issue is
   behavioral.
3. Map every acceptance criterion to an implementation step and a verification
   step.
4. Reuse existing architecture and testing conventions; do not invent a
   parallel pattern.
5. If the active agent is not `openai-codex/gpt-5.6-sol`, delegate this planning
   pass with that exact selector.

#### Stage 2 — Implement (`grok-4.5`)

1. Hand the executor exact target files, scope exclusions, required invariants,
   and acceptance criteria.
2. Implement source changes plus the smallest behavior-focused regression
   coverage that fails on the original bug.
3. Run focused tests and the real scenario the issue requires; type-check the
   result.
4. Do not expand scope. Do not leave compatibility shims, placeholders, or
   follow-up TODOs.
5. Do not run project-wide formatting/test suites inside the implementer
   subagent — those run once centrally.

#### Stage 3 — Primary local ship-gate review (`openai-codex/gpt-5.6-sol`)

This is the **pre-delivery** review of the completed local change. It is
**not** one of the two post-PR independent reviews (Stage 5).

1. Review the local diff before any delivery commit/PR.
2. Apply the canonical severity gate: only **Blocker** or **Material** findings
   require changes; drop **Cosmetic**.
3. Check acceptance criteria, error paths, lifecycle/resource behavior, and
   whether tests fail on the original bug.
4. Resolve every Blocker/Material finding before creating the final delivery
   commit.
5. Ship-gate prompt: **"Any Blocker or Material issue? If no → APPROVED."**

#### Stage 4 — Commit, push, and open the PR

1. Refresh `origin/main`, create/update the feature branch, and preserve
   verified working-tree changes.
2. Use a focused branch name and a Conventional Commit message.
3. Push the branch and open a PR whose body includes summary, exact
   verification commands, and `Closes #<issue>`.
4. A local-only implementation is **not** complete when the task is to execute
   a GitHub issue end to end.

#### Stage 5 — Two independent post-PR reviews (parallel)

Run **both** reviews independently against the same pushed PR diff and issue
context. Reviewers MUST NOT see or rely on each other's output.

1. `grok-4.5` independent review
2. `openai-codex/gpt-5.6-sol` independent review

Publish **both** outputs as PR comments so maintainers can inspect the
independent reasoning. Use the templates below.

**Independent PR review comment template**

```markdown
**Independent review — <Grok 4.5 | GPT 5.6 Sol>** (`<grok-4.5 | openai-codex/gpt-5.6-sol>`)

**Verdict: APPROVED** | **Verdict: CHANGES REQUESTED**

### Evidence
- <file/symbol or acceptance criterion → what the diff does / proves>

### Findings
<!-- Only Blocker or Material. Omit this section entirely when APPROVED with none. -->
- **<Blocker|Material>** `<path>:<lines>`: <impact>. <exact fix>.
```

#### Stage 6 — Finding-resolution loop (max two rounds)

1. If either independent review raises a **Blocker** or **Material** finding,
   post it (already on the PR), fix it, run focused verification, commit, and
   push the correction.
2. Request **one** follow-up verification from the **same reviewer that raised
   the finding**, and post that follow-up as a PR comment.
3. Apply the canonical two-round cap from `/home/marcelsud/.claude/CLAUDE.md`:
   Round 1 = substance; Round 2 = verify Round 1 fixes. No Round 3 unless a
   genuine **Blocker** appears. Stop when only Cosmetic feedback remains.

**Raising-reviewer follow-up comment template**

```markdown
**<Grok 4.5 | GPT 5.6 Sol> — follow-up review** (`<grok-4.5 | openai-codex/gpt-5.6-sol>`)

**Verdict: APPROVED** | **Verdict: CHANGES REQUESTED**

### Evidence
- <fix commit / diff hunk → how each prior Blocker/Material finding was resolved>
- <focused verification command and result>

### Findings
<!-- Only new or unresolved Blocker/Material. Omit when APPROVED with none. -->
- **<Blocker|Material>** `<path>:<lines>`: <impact>. <exact fix>.
```

#### Stage 7 — Completion proof

Before reporting done, verify and link all of the following:

- [ ] PR URL, title, base/head branches, and commit IDs
- [ ] PR is open and mergeable
- [ ] CI/checks pass on the **latest** commit
- [ ] Both independent review comments are present on the PR
- [ ] Every Blocker/Material finding has a posted resolution/follow-up
- [ ] Local branch is fully pushed; working tree is clean
- [ ] Temporary test infrastructure / services started for verification are stopped

Report configured model selectors accurately; do not claim upstream model
identity beyond what the harness records.

#### Worked example — issue #29 → PR #38

| Stage | What ran |
|-------|----------|
| 1 Plan | `openai-codex/gpt-5.6-sol` planned deferred Redis Streams consumer-group `XACK` until pipeline delivery succeeds |
| 2 Implement | `grok-4.5` implemented deferred `ack`, pipeline failure-channel propagation, unit + real-Redis `XPENDING` coverage |
| 3 Primary local review | `openai-codex/gpt-5.6-sol` ship-gated the local diff (Blocker/Material only) before delivery |
| 4 PR | Branch pushed; PR #38 opened with verification commands and `Closes #29` |
| 5 Independent reviews | Grok posted **APPROVED**; GPT posted **CHANGES REQUESTED** — both as PR comments, neither seeing the other |
| 6 Fix + follow-up | GPT Material finding: E2E harness forwarded only host/port, dropping Redis URL password/DB (`tests/e2e/redis-streams-ack.test.ts`). Corrective commit parsed password + DB; focused proof: `CASCADE_E2E_REDIS_URL=redis://:secret@127.0.0.1:6380/2 bun test tests/e2e/redis-streams-ack.test.ts`. GPT follow-up **APPROVED** on the PR |
| 7 Completion proof | Latest CI green, PR mergeable, both reviews + follow-up present, branch fully pushed and clean, temporary Redis/test services stopped |

## Component Guides

### Component Types

1. **Inputs**: Read from sources (HTTP webhooks, SQS, Redis Streams)
   - Return: `Stream<Message, Error, Dependencies>`
   - Example: `src/inputs/http-input.ts`

2. **Processors**: Transform messages (Metadata, Uppercase, Mapping, Logging)
   - Signature: `(message: Message) => Effect<Message, Error>`
   - Example: `src/processors/metadata-processor.ts`

3. **Outputs**: Send to destinations (HTTP APIs/webhooks, SQS, Redis Streams)
   - Signature: `(message: Message) => Effect<void, Error>`
   - Example: `src/outputs/http-output.ts`

### Creating New Components

All components follow the same pattern:

```typescript
import { Effect } from "effect"
import { Schema } from "effect/Schema"

// 1. Define config schema
const MyComponentConfig = Schema.Struct({
  url: Schema.String,
  option: Schema.optional(Schema.Number)
})

// 2. Create component factory
export const createMyComponent = (config: Schema.Schema.Type<typeof MyComponentConfig>) =>
  Effect.gen(function* () {
    // Setup resources
    const client = yield* createClient(config.url)

    // Return component function
    return (message: Message) =>
      Effect.gen(function* () {
        // Process message
        yield* Effect.log(`Processing: ${message.messageId}`)
        // Return transformed message or void
      })
  })
```

**Full guide**: See `docs/COMPONENTS.md`

## Important Patterns

### Effect.js Generator Syntax
All asynchronous code uses `Effect.gen` for generator-based syntax:

```typescript
const program = Effect.gen(function* () {
  const config = yield* loadConfig("pipeline.yaml")
  const pipeline = yield* buildPipeline(config)
  const result = yield* run(pipeline)
  return result
})
```

### Schema Validation
Configurations are validated using Effect Schema:

```typescript
import { Schema } from "effect/Schema"

const Config = Schema.Struct({
  url: Schema.String,
  region: Schema.optional(Schema.String)
})

// Decode and validate
const decode = Schema.decodeUnknown(Config)
const config = yield* decode(rawData)
```

### Error Types
The project defines custom error types in `src/core/errors.ts`:

- `FileReadError`: Cannot read configuration file
- `YamlParseError`: Invalid YAML syntax
- `ConfigValidationError`: Schema validation failed
- `BuildError`: Pipeline build failed
- `PipelineError`: Pipeline execution error

### Resource Management
Use Effect's resource management for cleanup:

```typescript
Effect.gen(function* () {
  const client = yield* Effect.acquireRelease(
    createClient(url),           // Acquire
    (client) => client.close()   // Release
  )
  // Use client
})
```

### Stream Processing
Inputs use Effect Streams for backpressure:

```typescript
import { Stream } from "effect"

const stream = Stream.fromIterable(messages).pipe(
  Stream.mapEffect((msg) => processMessage(msg)),
  Stream.runCollect
)
```

### CLI Error Handling
The CLI (`src/cli.ts`) handles Effect errors by formatting them for user-friendly display:

- Tagged errors (with `_tag` field) are formatted specially
- `FileReadError` → "Cannot read file: {path}"
- `YamlParseError` → "Invalid YAML syntax: {message}"
- `ConfigValidationError` → "Configuration validation failed\n{details}"

## Links

- **Testing Strategy**: `docs/TESTING.md` ⭐ Start here for testing!
- **Component Development**: `docs/COMPONENTS.md`
- **Input Docs**: `docs/inputs/`
- **Processor Docs**: `docs/processors/`
- **Output Docs**: `docs/outputs/`
- **Advanced Features**: `docs/advanced/` (DLQ, Backpressure, Bloblang)
- **Example Configs**: `configs/`
- **Effect.js Docs**: https://effect.website/
