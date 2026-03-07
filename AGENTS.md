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
