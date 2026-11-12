# Effect 4 migration

Cascade uses Effect `4.1.4` and the matching `@effect/platform-node` version.
Pipeline YAML and component delivery contracts are unchanged. Library consumers
and custom registry modules must use Effect 4 throughout the same application;
Effect 3 values are not compatible with this runtime.

## Development requirements

- Node.js 24 or newer (Cascade's supported development/runtime baseline).
- TypeScript 5.9 or newer with strict checking.
- Bun for the frozen lockfile and standalone binary build.

From the repository root:

```bash
bun install --frozen-lockfile
npm run lint
npm run build
npm run test:unit
npm run run-pipeline -- test "tests/yaml/**/*.yaml"
npm run build:binary
```

Unit tests include local HTTP requests, queue overflow and EOF draining,
acknowledgements, retry schedules, fatal errors, graceful shutdown, and a compiled
binary that runs without Node or Bun in its PATH. Real Redis/SQS scenarios also
require the infrastructure described in [Local Development Setup](local-development.md).

## Custom components

Import Schema from `effect/Schema` and HTTP modules from `effect/http`.
The separate `@effect/platform` dependency is no longer needed. Keep Effect and
platform packages at the same exact version; the HTTP/platform APIs are still
marked unstable upstream.

Registry definitions now accept `Schema.Codec<Config, unknown>` with no decoding
service requirements. `Schema.Schema<T>` describes only the decoded type in
Effect 4. Inferred types use `typeof schema.Type`:

```typescript
import { Effect, Schema } from "effect"

const Config = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  mode: Schema.Literals(["append", "replace"])
})
type Config = typeof Config.Type

const config: Config = await Effect.runPromise(
  Schema.decodeUnknownEffect(Config)({ name: "example", mode: "append" })
)
```

Use `Effect.catch`, `Effect.result`, `Effect.forkChild` and `Effect.forkDetach`
for the corresponding former `catchAll`, `either`, `fork` and `forkDaemon` APIs.
`Stream.runCollect` returns an array. Filters use `Result`, and stream pulls end
with `Cause.done()`. An explicit queue shutdown interrupts pending consumers;
normal producer completion must preserve buffered records until they drain.

See the [official migration guides](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
for the complete API and behavior changes, and [Component Registry](component-registry.md)
for Cascade's registration contract.
