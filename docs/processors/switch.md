# Switch Processor

The **switch processor** evaluates JSONata boolean expressions and executes the first matching case's nested processors. Similar to switch/case statements in programming languages, it enables **conditional routing** based on message content.

## Use Cases

- Route messages to different processors based on type/priority
- Apply different transformations based on message properties
- Handle different message formats with appropriate processors
- Implement conditional business logic

## Configuration

```yaml
pipeline:
  processors:
    - switch:
        cases:
          - check: type = "order"
            processors:
              - http:
                  url: "https://api.example.com/orders"
                  method: "POST"

          - check: type = "refund"
            processors:
              - http:
                  url: "https://api.example.com/refunds"
                  method: "POST"

          - check: priority = "urgent"
            processors:
              - log:
                  level: "warn"
```

## Behavior

1. Evaluates `check` expressions in order (top to bottom)
2. Executes the first matching case's processors
3. Stops after first match (**no fallthrough**)
4. Returns message unchanged if no case matches

Matched processor chains preserve cardinality: a nested filter can suppress the
message, and a nested processor that returns multiple messages propagates all
of them in order.

### Check Expressions

Check expressions are JSONata boolean expressions evaluated against the message content:

```yaml
# Simple equality
- check: type = "order"

# Numeric comparison
- check: amount >= 100

# Complex logic
- check: amount >= 100 and priority = "high"

# Metadata access
- check: $meta.source = "external-api"

# Message properties
- check: $message.timestamp < $now()
```

### Example

**Input messages**:
```json
{"type": "order", "amount": 100}
{"type": "refund", "amount": 50}
{"type": "payment", "amount": 25}
```

**With configuration**:
```yaml
- switch:
    cases:
      - check: type = "order"
        processors:
          - mapping:
              expression: $merge([$, {"route": "orders"}])
      - check: type = "refund"
        processors:
          - mapping:
              expression: $merge([$, {"route": "refunds"}])
```

**Output messages**:
```json
{"type": "order", "amount": 100, "route": "orders"}
{"type": "refund", "amount": 50, "route": "refunds"}
{"type": "payment", "amount": 25}  // Unchanged (no match)
```

## Available Variables in Check Expressions

- **Content fields**: Direct access to message content (e.g., `type`, `amount`)
- `$meta`: Message metadata object
- `$message`: Message properties (id, timestamp, correlationId)
- **JSONata functions**: All standard JSONata functions available

## Comparison with Branch Processor

| Aspect | Switch Processor | Branch Processor |
|--------|------------------|------------------|
| Purpose | Conditional routing | API enrichment |
| Original content | May be modified | Always preserved |
| Execution | First match only | Always executes |
| Result location | Replaces message | `metadata.branchResult` |
| Use case | Different paths | Parallel enrichment |

## Best Practices

1. **Order Matters**: Put most specific checks first, generic checks last
2. **No Fallthrough**: Unlike some languages, switch stops at first match
3. **Default Case**: Place a catch-all check at the end if needed (`true` always matches)
4. **Performance**: Check expressions are pre-compiled once at pipeline build time
5. **Boolean Coercion**: Non-boolean results are coerced to boolean (truthy/falsy)

### Default Case Pattern

```yaml
- switch:
    cases:
      - check: type = "order"
        processors: [...]
      - check: type = "refund"
        processors: [...]
      - check: "true"  # Default case (always matches)
        processors:
          - log:
              level: "warn"
              message: "Unhandled message type"
```

## Advanced Examples

### Complex Routing Logic

```yaml
- switch:
    cases:
      # High-priority urgent orders
      - check: type = "order" and priority = "urgent" and amount > 1000
        processors:
          - http:
              url: "https://api.example.com/urgent-orders"

      # Regular orders
      - check: type = "order"
        processors:
          - http:
              url: "https://api.example.com/orders"

      # Large refunds need approval
      - check: type = "refund" and amount > 500
        processors:
          - http:
              url: "https://api.example.com/refund-approval"
```

### Nested Switch (Recursive)

```yaml
- switch:
    cases:
      - check: category = "financial"
        processors:
          - switch:
              cases:
                - check: type = "deposit"
                  processors: [...]
                - check: type = "withdrawal"
                  processors: [...]
```

## Implementation Details

- Check expressions are compiled once at pipeline build (fast execution)
- Expressions evaluated in order specified in config
- First match wins (no fallthrough like C/JS switch)
- Supports recursive switch processors
- Thread-safe and stateless
- Returns original message unchanged if no case matches

## Error Handling

If a check expression evaluation fails:
- Throws `SwitchError` with details
- Pipeline error handling takes over (retry/DLQ)
- Check expression syntax errors caught at pipeline build time

## See Also

- [Branch Processor](./branch.md) - API enrichment pattern
- [Mapping Processor](./mapping.md) - JSONata transformations
- [Example Configs](../../tests/e2e/configs/switch-processor-test.yaml)
- [JSONata Documentation](https://docs.jsonata.org/)
