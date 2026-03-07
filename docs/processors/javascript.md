# JavaScript Processor

## Overview

Executes custom JavaScript code in a fully sandboxed environment powered by QuickJS (compiled to WebAssembly). Ideal for transformations that require imperative logic — loops, accumulators, complex conditionals — beyond what JSONata expressions can express.

The sandbox provides **complete isolation**: no access to the filesystem, network, Node.js APIs, or any host globals. Execution is constrained by configurable timeout and memory limits.

## Configuration

### Required Fields

- `code`: JavaScript code to execute. Must `return` the new message content.

### Optional Fields

- `timeout_ms`: Maximum execution time in milliseconds (default: `5000`)
- `memory_limit_bytes`: Maximum memory the script can allocate (default: `134217728` / 128MB)

## Available Variables

Inside the script, three variables are available:

| Variable   | Description                                      |
|------------|--------------------------------------------------|
| `content`  | The message content (object, array, or primitive) |
| `metadata` | The message metadata (read-only)                  |
| `message`  | `{ id, timestamp, correlationId }`                |

## Examples

### Basic Transformation

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          return {
            name: content.name.toUpperCase(),
            total: content.price * content.quantity,
            processed: true
          };
```

### Aggregation with Loops

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          var total = 0;
          var max = -Infinity;
          var min = Infinity;
          for (var i = 0; i < content.values.length; i++) {
            var v = content.values[i];
            total += v;
            if (v > max) max = v;
            if (v < min) min = v;
          }
          return {
            total: total,
            avg: total / content.values.length,
            max: max,
            min: min,
            count: content.values.length
          };
```

### Conditional Enrichment

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          var tier = "standard";
          if (content.spending > 10000) tier = "gold";
          else if (content.spending > 5000) tier = "silver";

          return {
            customerId: content.id,
            name: content.name,
            tier: tier,
            discount: tier === "gold" ? 0.15 : tier === "silver" ? 0.10 : 0.05,
            source: metadata.source
          };
```

### Fan-Out (One Message to Many)

Returning an array produces multiple output messages:

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          return content.items.map(function(item) {
            return {
              orderId: content.orderId,
              item: item.name,
              price: item.price,
              customer: content.customer
            };
          });
```

Each element becomes a separate message with `fanOutIndex` in its metadata.

### Data Normalization

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          var events = [];
          var keys = Object.keys(content.sensors);
          for (var i = 0; i < keys.length; i++) {
            var sensor = keys[i];
            var readings = content.sensors[sensor];
            for (var j = 0; j < readings.length; j++) {
              events.push({
                sensor: sensor,
                value: readings[j].value,
                ts: readings[j].timestamp,
                device: content.deviceId
              });
            }
          }
          return events;
```

### With Timeout and Memory Limits

```yaml
pipeline:
  processors:
    - javascript:
        code: |
          // Heavy computation with safety limits
          var result = [];
          for (var i = 0; i < content.records.length; i++) {
            var r = content.records[i];
            if (r.status === "active") {
              result.push({ id: r.id, score: r.value * r.weight });
            }
          }
          result.sort(function(a, b) { return b.score - a.score; });
          return { top: result.slice(0, 10), totalActive: result.length };
        timeout_ms: 3000
        memory_limit_bytes: 67108864
```

## Security Model

The JavaScript processor runs inside a **QuickJS WebAssembly sandbox**. This means:

| Concern        | Protection                                                    |
|----------------|---------------------------------------------------------------|
| File system    | No `fs`, `require`, or `import` available                      |
| Network        | No `fetch`, `XMLHttpRequest`, or socket APIs                   |
| Node.js APIs   | No `process`, `child_process`, `os`, `Buffer`, etc.            |
| Host globals   | No `globalThis` leak — only `content`, `metadata`, `message`   |
| CPU            | Execution killed after `timeout_ms`                            |
| Memory         | Allocation capped at `memory_limit_bytes`                      |
| Infinite loops | Interrupted by the timeout handler                             |

QuickJS runs as a completely separate JavaScript engine compiled to WASM — it does not share the Node.js runtime. User code cannot escape the sandbox.

## JavaScript vs Mapping (JSONata)

| Aspect                    | `javascript`                  | `mapping` (JSONata)          |
|---------------------------|-------------------------------|------------------------------|
| Style                     | Imperative                    | Declarative                  |
| Loops & accumulators      | Native support                | Limited                      |
| String/array built-ins    | Full JS standard library      | JSONata function library     |
| Learning curve            | Familiar to most developers   | JSONata-specific syntax      |
| Fan-out                   | Return an array               | Not supported                |
| Sandbox                   | QuickJS WASM isolate          | JSONata eval (in-process)    |
| Best for                  | Complex logic, data reshaping | Declarative field mapping    |

**Rule of thumb**: use `mapping` for simple field transformations, use `javascript` when you need loops, state, or fan-out.

## Metadata

After processing, messages receive:

- `javascriptProcessed: true`
- `fanOutIndex: <number>` (only when returning an array)

## Troubleshooting

### Script Errors

- Ensure the code ends with a `return` statement
- Check for syntax errors — QuickJS follows ES2020
- Use `var` instead of `let`/`const` for broader compatibility

### Timeout Errors

- The default timeout is 5 seconds — increase `timeout_ms` for heavy computation
- Avoid unbounded loops; always iterate over finite data

### Memory Errors

- Large data structures may exceed the memory limit
- Reduce `memory_limit_bytes` for untrusted inputs to limit blast radius
- Avoid building large intermediate arrays

## See Also

- [Mapping Processor](mapping.md) - Declarative JSONata transformations
- [Branch Processor](branch.md) - Run nested processor chains
- [Switch Processor](switch.md) - Conditional routing
