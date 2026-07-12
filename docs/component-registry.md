# Component Registry

Use a scoped component registry to add inputs, processors, and outputs without editing Cascade's built-in configuration schemas or pipeline builder.

## Register a component

Each definition provides its YAML key, Effect Schema configuration, and factory:

```typescript
import { Effect } from "effect"
import * as Schema from "effect/Schema"
import {
  createComponentRegistry,
  loadConfig,
  buildPipeline
} from "cascade"

const registry = createComponentRegistry().registerProcessor({
  name: "redact",
  schema: Schema.Struct({
    fields: Schema.Array(Schema.String)
  }),
  build: (config) =>
    Effect.succeed({
      name: "redact-processor",
      process: (message) =>
        Effect.succeed({
          ...message,
          content: redactFields(message.content, config.fields)
        })
    })
})

const config = await Effect.runPromise(loadConfig("pipeline.yaml", registry))
const pipeline = await Effect.runPromise(
  buildPipeline(config, false, registry)
)
```

The component is then available in YAML:

```yaml
pipeline:
  processors:
    - redact:
        fields: [password, token]
```

## Inputs and outputs

Use `registerInput` and `registerOutput` with the same definition shape. Input factories return an `Input`; output factories return an `Output`.

## Registry scope

Registries are explicit instances rather than global state. Pass the same registry to `loadConfig` and `buildPipeline`. This keeps registrations isolated between applications and tests.

If a registration conflicts with a built-in name, `loadConfig` returns a
`ConfigValidationError` in its Effect error channel. If a configuration was
loaded with a registry but that registry is omitted from `buildPipeline`, the
build fails with the unknown component name and a reminder to pass the registry.

Registry extension is currently a library API. The bundled CLI does not load
application-defined registrations, so custom components must be run through a
library entry point that passes the registry explicitly.

Registered schemas participate in the normal configuration rules:

- configuration is validated before pipeline construction;
- exactly one component key is required per input, output, or processor entry;
- registered processors work recursively inside `branch` and `switch`;
- registered outputs can be used as primary or DLQ destinations;
- duplicate names within a component kind are rejected;
- built-in component names cannot be replaced.

## Factory context

Factories receive a second argument containing `buildProcessor`. Advanced processor components can use it to construct nested processor configurations while preserving the active registry.
