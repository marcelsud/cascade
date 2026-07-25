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
| Plan | the orchestrating session itself — **never delegated**, see Stage 1 |
| Primary local ship-gate + one independent post-PR review | `openai-codex/gpt-5.6-sol` |
| Implement + the other independent post-PR review | `grok-4.5` |

- If a required selector is unavailable, **stop and report the blocker**. Never
  silently substitute another model.
- If the active agent already is the required GPT selector, it MAY review
  itself; otherwise delegate with the exact selector above.
- Shared lint, format, and project-wide checks run **once centrally** after
  implementation (or after a fix round). Subagents run focused verification
  only — not full-suite or format passes.

#### Stage 1 — Plan (the orchestrating session; **not delegated**)

1. Read the issue, `AGENTS.md`, canonical Claude instructions, relevant prior
   decisions, and affected code paths.
2. Reproduce the bug or establish pre-change behavior when the issue is
   behavioral. Run it. Quote the real output in the plan — a plan whose
   "pre-change behavior" was never executed is not a plan.
3. Map every acceptance criterion to an implementation step and a verification
   step.
4. Reuse existing architecture and testing conventions; do not invent a
   parallel pattern.
5. **Do not spawn a planning subagent.** Planning is the orchestrator's own
   work; delegation starts at Stage 2.

Why this stage is the exception:

- A planner subagent starts blank. It re-reads the issue, re-derives the code
  map, and returns a plan the orchestrator must re-verify before it can judge
  anything — a full round trip that buys **zero** parallelism, because by
  definition nothing else can run until the plan exists.
- The plan is exactly the artifact the orchestrator may not hand off: it fixes
  scope, decomposition, and the contracts every later stage is graded against.
  Delegating it and then grading it is self-review wearing two hats.
- Stage 1 has no model-boundary to buy. Stages 2, 3, and 5 cross a real one;
  this one only adds latency and a lossy handoff.

A read-only scout MAY still be used to *locate* code during planning —
"where is X", "which tests cover Y". Locating is not planning. Never hand a
scout the design, the acceptance mapping, or a decision.

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

#### Worked example — issue #65 → PR #86

| Stage | What ran |
|-------|----------|
| 1 Plan | The orchestrating session planned it directly: reproduced the defect in the worktree (`collected 0 of 32`), read the installed Effect queue/stream internals, chose drain-before-shutdown, recorded three rejected alternatives, and mapped AC-1…AC-5 to steps and commands. No planner subagent |
| 2 Implement | `grok-4.5` added the drain helper, both `!follow` call sites, and four regression cases; proved fail-first by reverting only `src/` and re-running |
| 3 Primary local review | `openai-codex/gpt-5.6-sol` ship-gated the local diff — APPROVED, no Blocker/Material |
| 4 PR | Branch pushed; PR #86 opened with verification commands and `Closes #65` |
| 5 Independent reviews | Both posted **CHANGES REQUESTED**, neither seeing the other, and both landed the same Material: the drain poll's `Effect.sleep` pinned Node forever on an abandoned one-shot input — a regression the *plan* introduced |
| 6 Fix + follow-up | Reviewers proposed different fixes; the session ruled for removing the timer entirely over patching one caller, and recorded why on the PR. Round 2: Grok **APPROVED**; GPT raised a *new* Material (chunks widened past `Stream.DefaultChunkSize` for `queue_size > 4096`, breaking the AC-5 backpressure contract). Verified against source, fixed, pinned by a failing-first test (`expected [ 5000 ] to deeply equal [ 4096, 904 ]`), then stopped at the two-round cap |
| 7 Completion proof | CI green on the latest commit, PR mergeable, both reviews + both follow-ups + two rulings present, branch clean and pushed, no services left running |

Note what Stage 5 caught: a flaw in the plan itself, authored by the same
session that judged the reviews. That is the argument for keeping Stage 1
in the main thread *and* keeping Stages 3 and 5 on other models — the
independence that matters is at review time, not at planning time.

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
