# Component Development Guide

This document outlines the principles and patterns for developing inputs, outputs, and processors in Cascade. The library is inspired by Benthos/Redpanda Connect and built on Effect.js for robust, type-safe stream processing.

## Table of Contents

- [⚠️ CRITICAL: Component Registration Pattern](#️-critical-component-registration-pattern)
- [Philosophy](#philosophy)
- [Core Principles](#core-principles)
- [Input Components](#input-components)
- [Output Components](#output-components)
- [Processor Components](#processor-components)
- [Effect.js Patterns](#effectjs-patterns)
- [Configuration Schema](#configuration-schema)
- [Testing Requirements](#testing-requirements)
- [Code Templates](#code-templates)
- [Common Mistakes & Troubleshooting](#common-mistakes--troubleshooting)

---

## ⚠️ CRITICAL: Component Registration Pattern

### The 3-File Pattern (REQUIRED)

**Every new component MUST be registered in THREE files or it will be unusable via YAML configuration.**

This is the #1 cause of "component not found" errors. Unit tests will pass (they import components directly), but E2E tests and user YAML configs will fail.

#### Required Files:

```
1. src/[inputs|processors|outputs]/my-component.ts  ← Component implementation
2. src/core/config-loader.ts                        ← Effect Schema definition
3. src/core/pipeline-builder.ts                     ← Builder logic
```

#### Step-by-Step Registration:

**Step 1: Implement Component** (`src/inputs/my-component.ts`)
```typescript
export interface MyComponentConfig {
  readonly url: string
  readonly timeout?: number
}

export const createMyComponent = (config: MyComponentConfig): Input => {
  // Implementation
}
```

**Step 2: Add Schema** (`src/core/config-loader.ts`)
```typescript
// Add schema for your component
const MyComponentInputSchema = S.Struct({
  url: S.String,
  timeout: S.optional(S.Number),
})

// CRITICAL: Add to union schema
const InputConfigSchema = S.Struct({
  aws_sqs: S.optional(AwsSqsInputSchema),
  redis_streams: S.optional(RedisStreamsInputSchema),
  my_component: S.optional(MyComponentInputSchema),  // ← ADD THIS LINE
  // ... other inputs
})
```

**Step 3: Add Builder** (`src/core/pipeline-builder.ts`)
```typescript
// CRITICAL: Add import
import { createMyComponent } from "../inputs/my-component.js"

const buildInput = (config: InputConfig): Effect.Effect<Input<any>, BuildError> => {
  // ... existing inputs

  // CRITICAL: Add builder case
  if (config.my_component) {
    return Effect.succeed(
      createMyComponent({
        url: config.my_component.url,
        timeout: config.my_component.timeout,
      })
    )
  }

  return Effect.fail(new BuildError("No valid input configuration found"))
}
```

### Verification Checklist

After implementing a component, verify registration:

- [ ] ✅ Component file exists in `src/inputs/` (or processors/outputs)
- [ ] ✅ Schema added to `InputConfigSchema` in `config-loader.ts`
- [ ] ✅ Import added to `pipeline-builder.ts`
- [ ] ✅ Builder case added to `buildInput()` function
- [ ] ✅ YAML config tested (not just unit tests!)
- [ ] ✅ E2E test created and passing

### YAML Configuration Format

**Inputs and Outputs**: Use direct keys
```yaml
input:
  my_component:  # ✅ Direct key (no "type:" field)
    url: "http://example.com"
    timeout: 5000
```

**Processors**: Use `pipeline:` wrapper
```yaml
pipeline:  # ✅ REQUIRED wrapper
  processors:
    - my_processor:
        field: "value"
```

**Common YAML Mistakes:**
```yaml
# ❌ WRONG - processors without pipeline wrapper
processors:
  - metadata:
      add_timestamp: true

# ✅ CORRECT - with pipeline wrapper
pipeline:
  processors:
    - metadata:
        add_timestamp: true

# ❌ WRONG - using "type" field for inputs
input:
  type: my_component
  url: "http://example.com"

# ✅ CORRECT - direct key
input:
  my_component:
    url: "http://example.com"
```

---

## Philosophy

### Benthos-Inspired Principles

1. **Declarative Configuration**: Components should be configurable via simple, readable YAML
2. **Graceful Degradation**: Don't crash on errors; log and continue when possible
3. **Composability**: Components must be reusable and combinable in different pipelines
4. **Transaction Model**: Support at-least-once delivery guarantees
5. **Resource Efficiency**: Use batching, connection pooling, and efficient resource management

### Effect.js Foundation

All components leverage Effect.js for:
- **Type-safe error handling**: Use tagged error classes in the error channel
- **Composable effects**: Build complex workflows from simple, testable pieces
- **Resource management**: Automatic cleanup with scoped resources
- **Structured concurrency**: Controlled parallelism and cancellation
- **Observability**: Built-in logging, tracing, and metrics

## Core Principles

### 1. Immutability

- **Never mutate input messages**
- **Always return new objects** with `{ ...msg, changes }`
- **Use `readonly` modifiers** in TypeScript interfaces

### 2. Error Handling Strategy

```typescript
// Categorize errors appropriately
- Intermittent errors (network, connectivity) → Error level, retry
- Logical errors (bad data format) → Debug level, continue
- Fatal errors (missing config) → Throw immediately, stop pipeline
```

### 3. Metadata Enrichment

Every component should add metadata about its processing:

```typescript
{
  ...msg,
  metadata: {
    ...msg.metadata,
    processedBy: "component-name",
    processedAt: new Date().toISOString(),
    // Component-specific metadata
  }
}
```

### 4. Resource Cleanup

Always implement optional `close()` method for graceful shutdown:

```typescript
close: () => Effect.Effect<void, never, never>
```

## Input Components

### Interface Contract

```typescript
interface Input<E = never, R = never> {
  readonly name: string
  readonly stream: Stream.Stream<Message, E, R>
  readonly close?: () => Effect.Effect<void, never, never>
}
```

### Implementation Guidelines

#### 1. Configuration

```typescript
export interface ComponentInputConfig {
  // Required fields
  readonly endpoint: string

  // Optional fields with sensible defaults
  readonly pollInterval?: number  // milliseconds
  readonly batchSize?: number     // messages per batch
  readonly timeout?: number       // operation timeout

  // Authentication (optional)
  readonly credentials?: {
    readonly username: string
    readonly password: string
  }
}
```

#### 2. Error Handling

```typescript
export class ComponentInputError {
  readonly _tag = "ComponentInputError"
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) {}
}
```

#### 3. Stream Creation

Use `Stream.repeatEffect` for continuous polling:

```typescript
const stream = Stream.repeatEffect(
  Effect.gen(function* () {
    // Poll for messages
    const messages = yield* pollMessages()

    // Convert to internal format
    return yield* Effect.forEach(
      messages,
      convertMessage,
      { concurrency: config.concurrency ?? 5 }
    )
  })
).pipe(
  Stream.flatMap(Stream.fromIterable),
  Stream.catchAll((error) =>
    Effect.gen(function* () {
      yield* Effect.logError(`Input error: ${error.message}`)
      yield* Effect.sleep("5 seconds")
      return Stream.empty
    })
  )
)
```

#### 4. Message Conversion

Convert external format to internal `Message`:

```typescript
const convertMessage = (external: ExternalMessage): Effect.Effect<Message, ComponentInputError> =>
  Effect.gen(function* () {
    return {
      id: crypto.randomUUID(),
      content: parseContent(external.body),
      metadata: {
        source: "component-name",
        externalId: external.id,
        receivedAt: new Date().toISOString(),
        ...extractMetadata(external)
      },
      timestamp: Date.now(),
      correlationId: external.correlationId
    }
  })
```

#### 5. Acknowledgment

Only acknowledge messages after successful conversion:

```typescript
// Convert message
const msg = yield* convertMessage(externalMsg)

// Acknowledge (delete/ack) after conversion
yield* acknowledgeMessage(externalMsg.id)

return msg
```

### Best Practices

1. **Use long polling** when available for efficiency
2. **Batch message retrieval** to reduce API calls
3. **Handle backpressure** by respecting downstream capacity
4. **Implement retry logic** with exponential backoff
5. **Log at appropriate levels**:
   - INFO: Connection established, polling started
   - DEBUG: Messages received, batches processed
   - ERROR: Connection failures, retry attempts
6. **Support graceful termination** for inputs with logical endpoints
7. **Preserve trace context** in metadata for observability

## Output Components

### Interface Contract

```typescript
interface Output<E = never, R = never> {
  readonly name: string
  readonly send: (msg: Message) => Effect.Effect<void, E, R>
  readonly close?: () => Effect.Effect<void, never, never>
}
```

### Implementation Guidelines

#### 1. Configuration

```typescript
export interface ComponentOutputConfig {
  // Required fields
  readonly destination: string

  // Batching options
  readonly maxBatchSize?: number  // 1 = no batching
  readonly batchTimeout?: number  // flush after timeout

  // Retry configuration
  readonly maxRetries?: number
  readonly retryDelay?: number

  // Connection pooling
  readonly maxConnections?: number
}
```

#### 2. Single vs Batch Sending

Support both modes based on `maxBatchSize`:

```typescript
export const createComponentOutput = (config: ComponentOutputConfig): Output<ComponentOutputError> => {
  const batchSize = config.maxBatchSize ?? 1

  if (batchSize === 1) {
    // Single message mode
    return {
      name: "component-output",
      send: (msg: Message) => sendSingle(msg)
    }
  } else {
    // Batch mode with accumulation
    let batch: Message[] = []

    return {
      name: "component-output",
      send: (msg: Message) =>
        Effect.gen(function* () {
          batch.push(msg)

          if (batch.length >= batchSize) {
            yield* sendBatch(batch)
            batch = []
          }
        }),
      close: () =>
        Effect.gen(function* () {
          if (batch.length > 0) {
            yield* sendBatch(batch)
          }
          yield* cleanup()
        })
    }
  }
}
```

#### 3. Message Serialization

Convert internal `Message` to external format:

```typescript
const serializeMessage = (msg: Message): ExternalFormat => ({
  id: msg.id,
  body: JSON.stringify(msg.content),
  attributes: {
    correlationId: msg.correlationId,
    timestamp: msg.timestamp.toString(),
    ...serializeMetadata(msg.metadata)
  },
  // Preserve trace context
  trace: msg.trace
})
```

#### 4. Retry Logic

Use Effect.js retry capabilities:

```typescript
const sendWithRetry = (msg: Message) =>
  sendMessage(msg).pipe(
    Effect.retry({
      times: config.maxRetries ?? 3,
      schedule: Schedule.exponential("1 second")
    }),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.logError(`Failed to send after retries: ${error.message}`)
        return Effect.fail(new ComponentOutputError("Max retries exceeded", error))
      })
    )
  )
```

### Best Practices

1. **Design for idempotency** when possible
2. **Use batch sends** for efficiency (up to 10-100 messages depending on service)
3. **Implement connection pooling** to reuse connections
4. **Flush batches on close()** to prevent data loss
5. **Handle partial batch failures** gracefully
6. **Add backoff between retries**
7. **Log send metrics**:
   - INFO: Batches sent, connection status
   - DEBUG: Individual messages, serialization
   - ERROR: Send failures, retry attempts

## Processor Components

### Interface Contract

```typescript
interface Processor<E = never, R = never> {
  readonly name: string
  readonly process: (msg: Message) => Effect.Effect<Message | Message[], E, R>
}
```

### Implementation Guidelines

#### 1. Configuration

```typescript
export interface ComponentProcessorConfig {
  // Processor-specific configuration
  readonly field?: string
  readonly enabled?: boolean

  // Common options
  readonly logLevel?: "debug" | "info" | "warn" | "error"
}
```

#### 2. Simple Synchronous Processor

```typescript
export const createComponentProcessor = (
  config: ComponentProcessorConfig = {}
): Processor => ({
  name: "component-processor",
  process: (msg: Message): Effect.Effect<Message> =>
    Effect.sync(() => ({
      ...msg,
      content: transformContent(msg.content, config),
      metadata: {
        ...msg.metadata,
        processedBy: "component-processor",
        processedAt: new Date().toISOString()
      }
    }))
})
```

#### 3. Asynchronous Processor

```typescript
export const createComponentProcessor = (
  config: ComponentProcessorConfig
): Processor<ComponentProcessorError> => ({
  name: "component-processor",
  process: (msg: Message): Effect.Effect<Message, ComponentProcessorError> =>
    Effect.gen(function* () {
      // Async operation
      const result = yield* Effect.tryPromise({
        try: async () => await externalService.process(msg.content),
        catch: (error) => new ComponentProcessorError("Processing failed", error)
      })

      return {
        ...msg,
        content: result,
        metadata: {
          ...msg.metadata,
          processedBy: "component-processor"
        }
      }
    })
})
```

#### 4. Processor with Filtering

Processors can filter messages by returning empty arrays:

```typescript
process: (msg: Message): Effect.Effect<Message | Message[]> =>
  Effect.sync(() => {
    if (shouldFilter(msg.content)) {
      return []  // Drop message
    }
    return transformMessage(msg)
  })
```

#### 5. Processor with Splitting

Processors can split one message into many:

```typescript
process: (msg: Message): Effect.Effect<Message[]> =>
  Effect.sync(() => {
    const parts = splitContent(msg.content)
    return parts.map(part => ({
      ...msg,
      id: crypto.randomUUID(),  // New ID for each part
      content: part,
      metadata: {
        ...msg.metadata,
        originalId: msg.id,
        partIndex: parts.indexOf(part),
        totalParts: parts.length
      }
    }))
  })
```

### Best Practices

1. **Keep processors focused** on a single transformation
2. **Compose complex logic** from multiple simple processors
3. **Validate input** before processing
4. **Handle missing fields gracefully** (don't crash on optional data)
5. **Add descriptive metadata** about what was transformed
6. **Use appropriate Effect constructors**:
   - `Effect.sync` for pure synchronous operations
   - `Effect.gen` for complex async flows
   - `Effect.tryPromise` for Promise-based APIs
7. **Log transformation details** at DEBUG level
8. **Preserve trace context** through transformations

## Effect.js Patterns

### Common Patterns Used in Components

#### 1. Effect.gen for Complex Flows

```typescript
Effect.gen(function* () {
  const data = yield* fetchData()
  const transformed = yield* transform(data)
  yield* Effect.log(`Processed: ${transformed.id}`)
  return transformed
})
```

#### 2. Effect.tryPromise for SDK Calls

```typescript
yield* Effect.tryPromise({
  try: async () => await client.send(command),
  catch: (error) => new ComponentError("Operation failed", error)
})
```

#### 3. Effect.forEach for Parallel Processing

```typescript
yield* Effect.forEach(
  items,
  processItem,
  { concurrency: 5 }  // Process 5 at a time
)
```

#### 4. Stream.repeatEffect for Polling

```typescript
Stream.repeatEffect(
  Effect.gen(function* () {
    yield* Effect.sleep(config.pollInterval)
    return yield* poll()
  })
)
```

#### 5. Effect.catchAll for Error Recovery

```typescript
operation.pipe(
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      yield* Effect.logError(`Error: ${error.message}`)
      yield* Effect.sleep("5 seconds")
      return defaultValue
    })
  )
)
```

#### 6. Resource Management with Effect.acquireRelease

```typescript
const withConnection = Effect.acquireRelease(
  Effect.tryPromise(() => createConnection()),
  (conn) => Effect.promise(() => conn.close())
)
```

## Configuration Schema

### Adding to config-loader.ts

```typescript
// 1. Define schema using @effect/schema
const ComponentInputSchema = S.Struct({
  url: S.String,
  region: S.optional(S.String),
  batch_size: S.optional(S.Number)
})

// 2. Add to InputConfigSchema union
export const InputConfigSchema = S.Struct({
  aws_sqs: S.optional(SqsInputSchema),
  redis_streams: S.optional(RedisStreamsInputSchema),
  component_input: S.optional(ComponentInputSchema)  // Add here
})
```

### Adding to pipeline-builder.ts

```typescript
const buildInput = (config: InputConfig): Effect.Effect<Input<any>, BuildError> => {
  // Add new case
  if (config.component_input) {
    return Effect.succeed(
      createComponentInput({
        url: config.component_input.url,
        region: config.component_input.region,
        batchSize: config.component_input.batch_size
      })
    )
  }

  return Effect.fail(new BuildError("No valid input configuration found"))
}
```

## Testing Requirements

### Unit Tests

Every component must have unit tests covering:

1. **Configuration**:
   - Valid configuration accepted
   - Invalid configuration rejected
   - Default values applied correctly

2. **Happy Path**:
   - Successful message processing
   - Correct format conversion
   - Metadata enrichment

3. **Error Handling**:
   - Recoverable errors logged and retried
   - Fatal errors propagated correctly
   - Graceful degradation

4. **Resource Management**:
   - close() cleans up properly
   - No resource leaks

### E2E Tests

Components should be tested in full pipelines:

```typescript
it("should process messages through complete pipeline", async () => {
  const mockInput = {
    name: "mock-input",
    stream: Stream.fromIterable(testMessages)
  }

  const processor = createComponentProcessor(config)

  const results: Message[] = []
  const mockOutput = {
    name: "mock-output",
    send: (msg: Message) => Effect.sync(() => results.push(msg))
  }

  const pipeline = create({
    name: "test-pipeline",
    input: mockInput,
    processors: [processor],
    output: mockOutput
  })

  const result = await Effect.runPromise(run(pipeline))

  expect(result.success).toBe(true)
  expect(results).toHaveLength(testMessages.length)
})
```

### Integration Tests

For inputs/outputs that connect to external services:
- Test against LocalStack (for AWS services)
- Test against local Docker containers (Redis, PostgreSQL, etc.)
- Include setup/teardown for test infrastructure

## Code Templates

### Input Template

```typescript
import { Effect, Stream } from "effect"
import type { Input, Message } from "../core/types.js"

export interface ComponentInputConfig {
  readonly url: string
  readonly batchSize?: number
}

export class ComponentInputError {
  readonly _tag = "ComponentInputError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export const createComponentInput = (
  config: ComponentInputConfig
): Input<ComponentInputError> => {
  // Initialize client
  const client = initializeClient(config)

  const stream = Stream.repeatEffect(
    Effect.gen(function* () {
      // Poll for messages
      const messages = yield* Effect.tryPromise({
        try: async () => await client.poll(),
        catch: (error) => new ComponentInputError("Poll failed", error)
      })

      // Convert and acknowledge
      return yield* Effect.forEach(
        messages,
        (msg) => Effect.gen(function* () {
          const converted = yield* convertMessage(msg)
          yield* acknowledgeMessage(msg.id)
          return converted
        }),
        { concurrency: 5 }
      )
    })
  ).pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.logError(`Input error: ${error.message}`)
        yield* Effect.sleep("5 seconds")
        return Stream.empty
      })
    )
  )

  return {
    name: "component-input",
    stream,
    close: () => Effect.promise(() => client.close())
  }
}
```

### Output Template

```typescript
import { Effect } from "effect"
import type { Output, Message } from "../core/types.js"

export interface ComponentOutputConfig {
  readonly url: string
  readonly maxBatchSize?: number
}

export class ComponentOutputError {
  readonly _tag = "ComponentOutputError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export const createComponentOutput = (
  config: ComponentOutputConfig
): Output<ComponentOutputError> => {
  const client = initializeClient(config)
  const batchSize = config.maxBatchSize ?? 1

  if (batchSize === 1) {
    // Single message mode
    return {
      name: "component-output",
      send: (msg: Message) =>
        Effect.tryPromise({
          try: async () => await client.send(serializeMessage(msg)),
          catch: (error) => new ComponentOutputError("Send failed", error)
        }),
      close: () => Effect.promise(() => client.close())
    }
  } else {
    // Batch mode
    let batch: Message[] = []

    return {
      name: "component-output",
      send: (msg: Message) =>
        Effect.gen(function* () {
          batch.push(msg)

          if (batch.length >= batchSize) {
            yield* sendBatch(batch)
            batch = []
          }
        }),
      close: () =>
        Effect.gen(function* () {
          if (batch.length > 0) {
            yield* sendBatch(batch)
          }
          yield* Effect.promise(() => client.close())
        })
    }
  }
}
```

### Processor Template

```typescript
import { Effect } from "effect"
import type { Processor, Message } from "../core/types.js"

export interface ComponentProcessorConfig {
  readonly field?: string
}

export class ComponentProcessorError {
  readonly _tag = "ComponentProcessorError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export const createComponentProcessor = (
  config: ComponentProcessorConfig = {}
): Processor<ComponentProcessorError> => ({
  name: "component-processor",
  process: (msg: Message): Effect.Effect<Message, ComponentProcessorError> =>
    Effect.gen(function* () {
      // Transform content
      const transformed = yield* Effect.tryPromise({
        try: async () => await transform(msg.content, config),
        catch: (error) => new ComponentProcessorError("Transform failed", error)
      })

      return {
        ...msg,
        content: transformed,
        metadata: {
          ...msg.metadata,
          processedBy: "component-processor",
          processedAt: new Date().toISOString()
        }
      }
    })
})
```

## Summary Checklist

### ⚠️ Critical Registration (DO NOT SKIP)

**Before considering a component complete, verify ALL of these:**

- [ ] **Component Implementation** (`src/[inputs|processors|outputs]/`)
  - [ ] Interface contract followed exactly
  - [ ] Tagged error classes for type safety
  - [ ] Optional `close()` method for cleanup
  - [ ] Comprehensive error handling
  - [ ] Metadata enrichment
  - [ ] Appropriate Effect.js patterns

- [ ] **Schema Registration** (`src/core/config-loader.ts`)
  - [ ] Created schema using `S.Struct()`
  - [ ] Added to `InputConfigSchema` / `ProcessorConfigSchema` / `OutputConfigSchema`
  - [ ] Property name matches YAML key (e.g., `my_component`)
  - [ ] All config fields defined with correct types
  - [ ] Optional fields marked with `S.optional()`

- [ ] **Builder Registration** (`src/core/pipeline-builder.ts`)
  - [ ] Import statement added at top of file
  - [ ] Builder case added to `buildInput()` / `buildProcessor()` / `buildOutput()`
  - [ ] Config properties mapped correctly
  - [ ] Handle readonly array conversions if needed (use spread: `[...array]`)
  - [ ] Component name added to pipeline name generation

- [ ] **Testing & Validation**
  - [ ] Unit tests (config, happy path, errors, cleanup)
  - [ ] **E2E test with YAML config** (CRITICAL - catches registration issues)
  - [ ] Test both success and failure scenarios
  - [ ] Verify with real services (Docker/LocalStack)
  - [ ] Pipeline executes successfully
  - [ ] Messages processed correctly

- [ ] **Documentation**
  - [ ] Export from `src/index.ts`
  - [ ] YAML configuration examples in README.md
  - [ ] Code examples provided
  - [ ] Common use cases documented

### Testing Priority

**Test in this order to catch issues early:**

1. ✅ Unit tests (verifies implementation)
2. ✅ **YAML E2E test** (verifies registration - MOST IMPORTANT)
3. ✅ Integration tests (verifies external service compatibility)

**Why E2E is critical:** Unit tests import components directly and will pass even if the component is not registered. Only E2E tests using YAML configs will catch registration issues.

---

## Common Mistakes & Troubleshooting

### Issue: "No valid input configuration found"

**Symptom:**
```
ERROR: BuildError: No valid input configuration found
```

**Causes:**
1. ❌ Component not registered in `pipeline-builder.ts`
2. ❌ Schema not added to `config-loader.ts`
3. ❌ YAML key doesn't match schema property name
4. ❌ Wrong YAML format (using `type:` instead of direct key)

**Solution:**
```bash
# 1. Check if component is imported in pipeline-builder.ts
grep "createMyComponent" src/core/pipeline-builder.ts

# 2. Check if builder case exists
grep "config.my_component" src/core/pipeline-builder.ts

# 3. Check if schema is registered
grep "my_component:" src/core/config-loader.ts

# 4. Verify YAML format
cat config.yaml  # Should use direct key, not "type:"
```

### Issue: "Pipeline built successfully with 0 processors"

**Symptom:**
```
INFO: Pipeline built successfully with 0 processors
```
But you have processors in your YAML config.

**Cause:** Missing `pipeline:` wrapper around `processors:`

**Wrong:**
```yaml
processors:  # ❌ Silently ignored
  - metadata:
      add_timestamp: true
```

**Correct:**
```yaml
pipeline:  # ✅ Required
  processors:
    - metadata:
        add_timestamp: true
```

### Issue: TypeScript compilation error - readonly arrays

**Symptom:**
```
Type 'readonly string[]' is not assignable to type 'string[]'
```

**Cause:** Effect Schema returns readonly arrays, components expect mutable arrays

**Solution:** Use spread operator to convert:
```typescript
// In pipeline-builder.ts
if (config.my_component) {
  return Effect.succeed(
    createMyComponent({
      items: config.my_component.items
        ? [...config.my_component.items]  // ✅ Convert readonly to mutable
        : undefined,
    })
  )
}
```

### Issue: Component works in unit tests but not in YAML

**Symptom:** All unit tests pass, but `cascade run config.yaml` fails

**Cause:** Unit tests import components directly, bypassing YAML configuration path

**Diagnosis:**
```bash
# Run YAML config test
cascade run test-config.yaml

# If it fails, check registration:
# 1. Schema in config-loader.ts?
# 2. Builder in pipeline-builder.ts?
# 3. Import statement added?
```

**Solution:** Always create an E2E test that uses YAML configuration

### Issue: Schema validation fails

**Symptom:**
```
ERROR: ConfigValidationError: Schema validation failed
```

**Common causes:**
1. Required field missing in YAML
2. Wrong data type (string vs number)
3. Invalid enum value
4. Missing `S.optional()` for optional fields

**Debug:**
```typescript
// Check schema definition
const MyComponentSchema = S.Struct({
  url: S.String,                    // Required
  port: S.Number,                   // Required
  timeout: S.optional(S.Number),    // Optional ✅
  retries: S.Int.pipe(S.positive()) // Must be positive integer
})
```

### Debugging Checklist

When a component doesn't work:

1. **Check all 3 files exist:**
   ```bash
   ls src/inputs/my-component.ts
   grep "my_component" src/core/config-loader.ts
   grep "my_component" src/core/pipeline-builder.ts
   ```

2. **Verify schema property name matches YAML:**
   ```typescript
   // In config-loader.ts
   const InputConfigSchema = S.Struct({
     my_component: S.optional(MyComponentSchema),  // Must match YAML key
   })
   ```

3. **Check builder logic:**
   ```typescript
   // In pipeline-builder.ts
   if (config.my_component) {  // Must match schema key
     return Effect.succeed(createMyComponent(...))
   }
   ```

4. **Test with YAML:**
   ```bash
   # Create minimal test config
   cat > test.yaml << EOF
   input:
     my_component:
       url: "http://test"
   output:
     capture: {}
   EOF

   # Run it
   cascade run test.yaml --debug
   ```

5. **Check debug logs:**
   ```bash
   cascade run config.yaml --debug 2>&1 | grep -i "my_component"
   ```

### Prevention

**Always use this workflow when adding a component:**

```bash
# 1. Implement component
vim src/inputs/my-component.ts

# 2. Add schema
vim src/core/config-loader.ts
# - Add schema definition
# - Add to InputConfigSchema

# 3. Add builder
vim src/core/pipeline-builder.ts
# - Add import
# - Add builder case

# 4. Build
npm run build

# 5. Create E2E test IMMEDIATELY
vim tmp-e2e-tests/configs/my-component-test.yaml
vim tmp-e2e-tests/scripts/test-my-component.sh

# 6. Run E2E test
./tmp-e2e-tests/scripts/test-my-component.sh

# 7. Only if E2E passes, write unit tests
vim src/inputs/my-component.test.ts
```

This workflow catches registration issues immediately, before writing unit tests.

---

## Additional Resources

- [Effect.js Documentation](https://effect.website)
- [Benthos Documentation](https://warpstreamlabs.github.io/bento/docs/about)
- [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)
- [Project README](../README.md)

---

**Version**: 1.1
**Last Updated**: 2025-01-13
**Maintainer**: Cascade Team

**Changelog**:
- v1.1 (2025-01-13): Added critical 3-file registration pattern, YAML format guide, and comprehensive troubleshooting section based on E2E testing findings
- v1.0 (2025-01-11): Initial version
