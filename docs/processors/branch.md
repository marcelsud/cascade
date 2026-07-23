# Branch Processor

The **branch processor** executes a nested pipeline on a copy of the message and merges the result back into the original message's metadata. This is the ideal pattern for **API enrichment** where you want to preserve the original message while adding enriched data.

## Use Cases

- Enrich user data from external APIs
- Add computed fields without modifying original message
- Run side-effect processors without affecting main pipeline
- Parallel processing scenarios where original data must be preserved

## Configuration

```yaml
pipeline:
  processors:
    - branch:
        processors:
          - metadata:
              add_timestamp: true
          - http:
              url: "https://api.example.com/enrich"
              result_key: "enrichment"
          - log:
              level: "info"
```

## Behavior

1. Creates a deep copy of the incoming message
2. Executes all nested processors sequentially on the copy
3. Merges each processed result into `metadata.branchResult`
4. Returns one copy of the **original message** for each branch result

If the nested chain produces no results, the original is suppressed. If it
produces multiple results, the branch emits multiple copies of the original in
the same order, each with its corresponding branch result.

### Example

**Input message**:
```json
{
  "id": "msg-1",
  "content": { "userId": "123", "action": "purchase" },
  "metadata": {}
}
```

**After branch processor**:
```json
{
  "id": "msg-1",
  "content": { "userId": "123", "action": "purchase" },  // Original preserved
  "metadata": {
    "branchResult": {
      "content": { ... },  // Result from nested pipeline
      "metadata": { ... }   // Metadata from nested pipeline
    }
  }
}
```

## Comparison with Regular Processors

| Aspect | Regular Processor | Branch Processor |
|--------|-------------------|------------------|
| Original content | Modified | **Preserved** |
| Original metadata | Modified | Preserved |
| Result location | Replaces content | `metadata.branchResult` |
| Use case | Transform data | Enrich data |

## Best Practices

1. **API Enrichment**: Use branch when calling external APIs to preserve original message
2. **Metadata Only**: If you only need metadata changes, don't use branch (use regular processors)
3. **Nested Depth**: Keep branch nesting shallow (max 2 levels) for readability
4. **Performance**: Branch creates deep clones - avoid in high-throughput scenarios

## Implementation Details

- Uses `JSON.parse(JSON.stringify())` for deep cloning
- Nested processors can themselves be branch/switch processors (recursive)
- Preserves zero-or-many results from nested processor chains
- Thread-safe and stateless

## See Also

- [Switch Processor](./switch.md) - Conditional routing
- [HTTP Processor](./http.md) - API calls
- [Example Configs](../../tests/e2e/configs/branch-processor-test.yaml)
