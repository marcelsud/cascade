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

> `npm run docker:up` and `npm run e2e:all` conflict. The shell E2E scripts
> start their own LocalStack on `4566` and an HTTP observer on `8081`, which the
> shared stack already binds. Run `npm run docker:down` before `e2e:all`.

### Continuous Audit

Supplies graded issues by auditing **one topic per run**. Breadth comes from
many runs, not from sweeping the repository in one.

Protocol for conducting a run: [`.github/grading/audit-protocol.md`](.github/grading/audit-protocol.md)
Spec: <https://github.com/marcelsud/specs/blob/main/continuous-audit.md>

The loop is **agent-driven**: you are the top-level process and call the tool
for every deterministic step. Nothing spawns or supervises you.

```bash
node .github/grading/audit-run.mjs start          # selects the topic, opens the run
node .github/grading/audit-run.mjs start --topic <id>   # on-demand run of a named topic
#   ... examine the topic, write a candidate issue body ...
node .github/grading/audit-run.mjs check c.md     # dedup, verify reproduction, grade
node .github/grading/audit-run.mjs file  c.md     # create the issue   (--dry-run to rehearse)
node .github/grading/audit-run.mjs drop  c.md --disposition duplicate --reason "..."
node .github/grading/audit-run.mjs finish --report report.md # append the ledger, close the run
node .github/grading/audit-run.mjs status         # is a run open?
```

Every command prints JSON on stdout. `start` reports the topic, run id, seed,
commit, and the fingerprints already recorded for that topic, so you do not
re-propose what the ledger already holds.

A candidate is the proposed **issue body**, carrying the grading record the
methodology requires plus one extra block:

```yaml
audit_candidate:
  path: src/inputs/http-input.ts
  consequence_category: reliability
  normalized_claim: request bodies buffered without a byte limit
  reproduction:
    runner: vitest
    test_files: [tests/unit/inputs/http-input.test.ts]
    test_name: rejects request bodies over the configured limit
    failure_contains: expected status 413
```

The tool ignores agent-selected shell commands. It creates a disposable
worktree at the audited commit, installs its toolchain from `bun.lock` with
scripts disabled, copies only the declared test files, and invokes Vitest
itself. A structured Vitest result must contain the named failing assertion and
declared failure text; a generic nonzero exit or printed text does not count.
The proof stores the tests, hashes, assertion output, runner/lockfile identity,
and replay command.

`file` refuses any candidate that did not pass `check` in the current run, and
decides that from the tool's own state rather than anything you assert. Resolve
every verified candidate — `file` it or `drop` it with a reason — or `finish`
refuses to close the run. `finish` also requires a structured report containing
the topic contracts, inspected paths, and behavior cells; the report is
validated to existing lines at the audited commit and its hash is stored in the
run ledger. `file` binds approval to that exact candidate body and both `file`
and `finish` reject a changed `HEAD`.

For selection alone, without opening a run:

```bash
node .github/grading/audit.mjs coverage           # staleness and churn per topic
node .github/grading/audit.mjs select --seed 123  # replay a selection exactly
```

**Topic registry**: `topics:` in `.github/grading/config.yml`. Every topic must
cite an objective from the `objectives:` registry above it, or it is skipped —
its findings would fail IE-7 only after the reproduction had already been paid
for. Adding or changing a topic is a policy change (spec §10.1): its own PR.

**Ledger**: the `grading-ledger` branch, append-only, never merged to `main`.

```bash
git show grading-ledger:topics.jsonl     # one entry per run
git show grading-ledger:findings.jsonl   # one entry per candidate, rejections included
```

Three rules the loop depends on:

- A run that finds nothing is a **successful** run. Treating an empty result as
  failure is what creates pressure to fabricate findings.
- A candidate is **not filed without a reproduction** whose named Vitest
  assertion fails with the declared output at the audited commit. A reasoned
  argument or arbitrary nonzero command is not a reproduction.
- A completed run carries hashed inspection evidence. Starting from a dirty
  tracked worktree or finishing from prose alone fails closed.
- An agent that produces no conforming artifact is a **failed run**, never a dry
  run. Recording it as dry marks the topic audited and opens a coverage hole.

### Agent calibration

Audit yield is not confidence. A model/prompt/toolchain/topic tuple earns
authority only from private, controller-signed labeled results:

```bash
node .github/grading/calibration.mjs evaluate /private/results.jsonl \
  --key-file /private/controller.key --require-qualified
```

The signing key and labeled cases stay outside the repository and outside the
agent's sandbox. The command reports precision, sensitivity, specificity,
abstention rate, and one-sided 95% Wilson lower bounds. It exits nonzero until
the thresholds in `.github/grading/config.yml` are met. The result describes
only the fixed benchmark; it is not a generalized code-quality claim.

### GitHub Issue Delivery (five-step workflow)

For graded Cascade GitHub issues, the default done state is **end-to-end
delivery** unless the user explicitly limits scope. Do not stop after local
implementation or local verification alone.

Issue grading and ship-gate linkage live in `.github/grading/config.yml` and the
repo grading methodology. Apply the existing severity gate and two-round
convergence rules from `/home/marcelsud/.claude/CLAUDE.md` (Blocker / Material /
Cosmetic; hard cap 2 rounds per artifact). **Do not redefine severity here** —
reference and apply that canonical guidance.

Steps 1–3 are the main thread's own work. The only delegated steps are the two
reviews.

| Step | Runs on |
|------|---------|
| 1 Plan | main thread |
| 2 Present the plan | main thread |
| 3 Implement | main thread |
| 4 Ship-gate review → delivery | review: `openai-codex/gpt-5.6-sol:high` (read-only) → commit / push / PR: main thread |
| 5 Independent pair review | `openai-codex/gpt-5.6-sol:high` **and** the second seat selected in step 5 |

If a required selector is unavailable, **stop and report the blocker**. Never
silently substitute another model. Report what each delegated seat resolved to
in the completion proof.

Shared lint, format, and project-wide checks run **once centrally** in the main
thread after implementation (or after a fix round). Review subagents run
focused verification only.

#### Step 1 — Plan (main thread, never delegated)

1. Read the issue, `AGENTS.md`, canonical Claude instructions, relevant prior
   decisions, and affected code paths.
2. Reproduce the bug or establish pre-change behavior when the issue is
   behavioral.
3. Map every acceptance criterion to an implementation step and a verification
   step.
4. Reuse existing architecture and testing conventions; do not invent a
   parallel pattern.

Planning buys no parallelism — nothing runs until the plan exists — and it
fixes the scope every later step is graded against. Delegating it and then
grading the result is self-review.

#### Step 2 — Present the plan (main thread)

State the plan before editing code: scope and non-scope, the files to touch,
each acceptance criterion mapped to its implementation and verification step,
and the reproduction that proves the bug is real.

This is a visibility gate, not an approval gate: proceed unless the user
redirects.

#### Step 3 — Implement (main thread)

1. Implement the source change plus the smallest behavior-focused regression
   coverage that fails on the original bug, and prove it fails before the fix.
2. Run focused tests and the real scenario the issue requires; type-check the
   result.
3. Do not expand scope. Do not leave compatibility shims, placeholders, or
   follow-up TODOs.
4. Run the shared lint/format/project-wide checks here, once.

#### Step 4 — Ship-gate review (`openai-codex/gpt-5.6-sol:high`), then open the PR

The ship-gate is the **pre-delivery** review of the completed local change. It
is not one of the two independent reviews in step 5. The reviewer is
**read-only**; the main thread performs every mutation.

1. Dispatch the ship-gate on the uncommitted diff, before any delivery commit.
   The prompt MUST carry the issue and its acceptance criteria, the step 2
   plan, and the worktree's absolute path. Without them the reviewer cannot
   grade the criteria it is being asked to grade.
2. It applies the canonical severity gate: only **Blocker** or **Material**
   findings require changes; drop **Cosmetic**.
3. It checks acceptance criteria, error paths, lifecycle/resource behavior, and
   whether the tests fail on the original bug.
4. Ship-gate prompt: **"Any Blocker or Material issue? If no → APPROVED."**
5. The **main thread** then resolves every Blocker/Material finding and
   performs delivery itself: refresh `origin/main`, commit on a focused branch
   name with a Conventional Commit message, push, and open the PR with a
   summary, the exact verification commands, and `Closes #<issue>`.

A local-only implementation is **not** complete when the task is to execute a
GitHub issue end to end.

#### Step 5 — Independent pair review (parallel)

Two seats, run against the same pushed PR diff and issue context. Reviewers
MUST NOT see or rely on each other's output.

Seat one is always `openai-codex/gpt-5.6-sol:high`. Seat two is chosen by the
**model family** running the main thread — compare families, never full
selectors: a Grok main thread runs `grok-4.5:high` while the Grok seat is
`grok-4.5:xhigh`, so a literal string comparison would seat Grok against Grok
and destroy the independence the seat exists to provide.

| Main-thread family | Seat two |
|---|---|
| `xai-oauth/grok-4.5` | `anthropic/claude-opus-5:high` |
| `anthropic/claude-opus-5` | `xai-oauth/grok-4.5:xhigh` |
| anything else | **stop and report the blocker** |

Any other main-thread model — GPT included — has no valid pairing, because
seat one is already GPT and a GPT main thread would then review its own work.
Stop rather than substitute.

Take the main-thread family from the model the **harness reports for the
running session**, not from configuration. `modelRoles.default` in
`~/.omp/agent/config.yml` is only the *configured* default and `omp --model`
overrides it, so the two disagree whenever a session was launched with an
explicit model — reading config would then seat the main thread's own family
against itself. Name both resolved seats in the completion proof.

The second seat keeps both reviews independent of the work under review: the
main thread wrote the plan and the implementation, so its own family cannot
also sit in judgement of them.

Publish **both** outputs as PR comments so maintainers can inspect the
independent reasoning.

**Independent PR review comment template**

```markdown
**Independent review — <reviewer label>** (`<selector>`)

**Verdict: APPROVED** | **Verdict: CHANGES REQUESTED**

### Evidence
- <file/symbol or acceptance criterion → what the diff does / proves>

### Findings
<!-- Only Blocker or Material. Omit this section entirely when APPROVED with none. -->
- **<Blocker|Material>** `<path>:<lines>`: <impact>. <exact fix>.
```

#### Finding-resolution loop (max two rounds)

1. If either independent review raises a **Blocker** or **Material** finding,
   fix it, run focused verification, commit, and push the correction.
2. Request **one** follow-up verification from the **same reviewer that raised
   the finding**, and post that follow-up as a PR comment.
3. Apply the canonical two-round cap from `/home/marcelsud/.claude/CLAUDE.md`:
   Round 1 = substance; Round 2 = verify Round 1 fixes. No Round 3 unless a
   genuine **Blocker** appears. Stop when only Cosmetic feedback remains.

**Raising-reviewer follow-up comment template**

```markdown
**<reviewer label> — follow-up review** (`<selector>`)

**Verdict: APPROVED** | **Verdict: CHANGES REQUESTED**

### Evidence
- <fix commit / diff hunk → how each prior Blocker/Material finding was resolved>
- <focused verification command and result>

### Findings
<!-- Only new or unresolved Blocker/Material. Omit when APPROVED with none. -->
- **<Blocker|Material>** `<path>:<lines>`: <impact>. <exact fix>.
```

#### Completion proof

Before reporting done, verify and link all of the following:

- [ ] PR URL, title, base/head branches, and commit IDs
- [ ] PR is open and mergeable
- [ ] CI/checks pass on the **latest** commit
- [ ] Both independent review comments are present on the PR
- [ ] Every Blocker/Material finding has a posted resolution/follow-up
- [ ] Local branch is fully pushed; working tree is clean
- [ ] Temporary test infrastructure / services started for verification are stopped

Report which model each delegated seat resolved to; do not claim upstream model
identity beyond what the harness records.

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
