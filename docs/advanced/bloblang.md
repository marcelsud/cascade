# Bloblang Integration

## Overview

While Cascade uses JSONata for transformations (via the `mapping` processor), you can also integrate Benthos Bloblang using its CLI. This is useful for teams migrating from Benthos or those familiar with Bloblang syntax.

## When to Use Bloblang

✓ **Use Bloblang if:**
- Migrating from Benthos with existing Bloblang scripts
- Team is familiar with Bloblang syntax
- Have complex Benthos-specific transformations

✗ **Use JSONata (built-in) if:**
- Starting fresh (no legacy scripts)
- Want in-process performance
- Prefer simpler deployment (no external binary)

## Installation

### macOS

```bash
brew install benthos
```

### Linux

```bash
curl -L https://github.com/benthosdev/benthos/releases/latest/download/benthos_linux_amd64.tar.gz | tar xz
sudo mv benthos /usr/local/bin/
```

### Verify Installation

```bash
benthos blobl --version
```

## Implementation

### Custom Bloblang Processor

Create a custom processor that shells out to the Bloblang CLI:

```typescript
// src/processors/bloblang-processor.ts
import { Effect } from "effect"
import { exec } from "child_process"
import { promisify } from "util"
import type { Processor, Message } from "../core/types.js"

const execAsync = promisify(exec)

export interface BloblangProcessorConfig {
  readonly mapping: string  // Bloblang mapping script
}

export class BloblangError {
  readonly _tag = "BloblangError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export const createBloblangProcessor = (
  config: BloblangProcessorConfig
): Processor<BloblangError> => {
  return {
    name: "bloblang-processor",
    process: (msg: Message): Effect.Effect<Message, BloblangError> => {
      return Effect.gen(function* () {
        // Convert message to JSON
        const input = JSON.stringify(msg.content)

        // Execute Bloblang CLI
        const result = yield* Effect.tryPromise({
          try: async () => {
            const { stdout, stderr } = await execAsync(
              `echo '${input.replace(/'/g, "'\\''")}' | benthos blobl "${config.mapping}"`
            )
            if (stderr) {
              throw new Error(stderr)
            }
            return JSON.parse(stdout)
          },
          catch: (error) =>
            new BloblangError(
              `Bloblang execution failed: ${error instanceof Error ? error.message : String(error)}`,
              error
            ),
        })

        return {
          ...msg,
          content: result,
          metadata: {
            ...msg.metadata,
            bloblangApplied: true,
          },
        }
      })
    },
  }
}
```

### Register in Pipeline Builder

Add support for the Bloblang processor in your pipeline builder:

```typescript
// In pipeline-builder.ts
case "bloblang":
  return createBloblangProcessor(config as BloblangProcessorConfig)
```

## Configuration

### YAML Configuration

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.fullName = this.firstName.uppercase() + " " + this.lastName.uppercase()
          root.email = this.email.lowercase()
          root.discountRate = match {
            this.tier == "gold" => 0.15,
            this.tier == "silver" => 0.10,
            _ => 0.05
          }
          root.total = this.items.map_each(item -> item.price).sum()
```

## Bloblang Examples

### Basic Transformation

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.name = this.firstName + " " + this.lastName
          root.email = this.email.lowercase()
```

### Conditional Logic

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root = this
          root.status = if this.age >= 18 {
            "adult"
          } else {
            "minor"
          }
```

### Array Operations

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.items = this.products.map_each(p -> {
            "name": p.name,
            "price": p.price * 1.1  # Add 10% markup
          })
          root.totalPrice = this.products.map_each(p -> p.price).sum()
```

### Pattern Matching

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.discount = match {
            this.tier == "platinum" => 0.20,
            this.tier == "gold" => 0.15,
            this.tier == "silver" => 0.10,
            this.orderTotal > 1000 => 0.05,
            _ => 0.0
          }
```

### Data Reshaping

```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.user.id = this.userId
          root.user.name = this.userName
          root.order.id = this.orderId
          root.order.items = this.items
          root.order.total = this.items.map_each(i -> i.price).sum()
```

## JSONata vs Bloblang Comparison

| Feature | JSONata (Built-in) | Bloblang (CLI) |
|---------|-------------------|----------------|
| **Installation** | npm dependency only | Requires Benthos binary |
| **Performance** | In-process (fast) | Subprocess overhead (slower) |
| **Syntax** | JSON-like expressions | Benthos-native DSL |
| **Learning Curve** | Moderate | Easy (for Benthos users) |
| **Ecosystem** | JSONata docs & community | Benthos docs & community |
| **Deployment** | Simple (Node.js only) | Complex (requires binary) |
| **Debugging** | JavaScript-based | CLI-based |
| **Best For** | New projects, general use | Benthos migrations |

### Syntax Comparison

**Same transformation in both:**

JSONata:
```javascript
{
  "fullName": $uppercase(firstName) & " " & $uppercase(lastName),
  "discount": tier = "gold" ? 0.15 : tier = "silver" ? 0.10 : 0.05
}
```

Bloblang:
```bloblang
root.fullName = this.firstName.uppercase() + " " + this.lastName.uppercase()
root.discount = match {
  this.tier == "gold" => 0.15,
  this.tier == "silver" => 0.10,
  _ => 0.05
}
```

## Performance Considerations

### Subprocess Overhead

- Each message spawns a new `benthos blobl` process
- Typical overhead: 10-50ms per message
- Not suitable for high-throughput pipelines (> 100 msg/sec)

### Optimization Strategies

1. **Batch Processing**: Process multiple messages per Bloblang invocation
2. **Caching**: Keep Bloblang process running (requires custom implementation)
3. **Selective Use**: Use Bloblang only for complex transformations
4. **Prefer JSONata**: Use built-in mapping processor when possible

## Migration from Benthos

### Converting Benthos Config

**Benthos:**
```yaml
pipeline:
  processors:
    - bloblang: |
        root.name = this.firstName.uppercase()
```

**Cascade:**
```yaml
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.name = this.firstName.uppercase()
```

### Testing Bloblang Scripts

Use the Bloblang CLI to test transformations:

```bash
# Test interactively
echo '{"firstName":"john"}' | benthos blobl 'root.name = this.firstName.uppercase()'

# From file
cat input.json | benthos blobl -f mapping.blobl
```

## Troubleshooting

### "benthos: command not found"

**Solution**:
```bash
# Verify installation
which benthos

# Add to PATH if needed
export PATH="/usr/local/bin:$PATH"
```

### Bloblang syntax errors

**Symptoms**: Processor fails with "Bloblang execution failed"

**Solutions**:
- Test mapping with CLI first: `echo '{}' | benthos blobl 'your mapping'`
- Check Bloblang syntax documentation
- Verify field names match input data
- Use `benthos blobl --help` for syntax reference

### Performance issues

**Symptoms**: Slow message processing, high CPU

**Solutions**:
- Switch to JSONata (in-process)
- Reduce Bloblang processor usage
- Implement batching
- Profile subprocess overhead

### Quote escaping issues

**Symptoms**: Shell interpretation errors

**Solutions**:
- Use heredoc in YAML: `mapping: |`
- Escape single quotes: `'\''`
- Store complex mappings in external files

## Best Practices

### Prefer JSONata for New Code

```yaml
# ✓ Good: Use built-in mapping processor
pipeline:
  processors:
    - mapping:
        expression: |
          { "name": $uppercase(firstName) }
```

```yaml
# ✗ Avoid: Unless migrating from Benthos
pipeline:
  processors:
    - type: "bloblang"
      config:
        mapping: |
          root.name = this.firstName.uppercase()
```

### Test Bloblang Mappings Offline

```bash
# Create test file
cat > test-input.json <<EOF
{"firstName":"john","lastName":"doe"}
EOF

# Test mapping
cat test-input.json | benthos blobl 'root.name = this.firstName.uppercase()'
```

### Document Why Using Bloblang

```yaml
# Comment explaining why Bloblang is used
pipeline:
  processors:
    # Using Bloblang for compatibility with legacy Benthos pipeline
    - type: "bloblang"
      config:
        mapping: |
          # Complex transformation from existing Benthos config
          root = this
```

## See Also

- [Mapping Processor](../processors/mapping.md) - Built-in JSONata transformations
- [Benthos Documentation](https://www.benthos.dev/docs/guides/bloblang/about) - Official Bloblang guide
- [JSONata Documentation](https://docs.jsonata.org/) - JSONata language reference
- [Uppercase Processor](../processors/uppercase.md) - Simple field transformation
