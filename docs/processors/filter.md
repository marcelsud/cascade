# Filter Processor

The **filter processor** evaluates a JSONata check and suppresses messages that
do not match. Suppressed messages do not reach later processors or the output,
but are treated as successfully handled and are acknowledged by the input.

## Configuration

```yaml
pipeline:
  processors:
    - filter:
        check: status = "active" and amount >= 100
```

`check` is required and must be a non-empty JSONata expression. The expression
is compiled when the pipeline is built, so invalid syntax prevents startup.

## Expression Context

- Content fields are directly accessible, such as `status` or `amount`.
- Primitive content is available through `value`.
- `$meta` contains message metadata.
- `$message` contains `id`, `timestamp`, and `correlationId`.

The result is coerced to a boolean. A truthy result forwards the original
message; a falsy result suppresses it. Evaluation errors are processing errors
that are logged, increment the pipeline failure count, and prevent source
acknowledgement.

```yaml
- filter:
    check: $meta.source = "api"

- filter:
    check: $message.correlationId != null
```

## Composition

Filter can be used at the top level or inside `switch` and `branch`.

- A filter inside a matched switch case can suppress that case's message.
- A filter inside a branch suppresses the original when the branch produces no
  result.
- If a nested processor produces multiple results, switch propagates all of
  them. Branch emits one original message per branch result, with the
  corresponding result stored in `metadata.branchResult`.

Accepted and dropped decisions are logged at debug level with the message ID;
message content is not logged.

## Example

```yaml
input:
  file:
    path: "./events.ndjson"
    follow: false
    start_at: beginning

pipeline:
  processors:
    - filter:
        check: type = "order" and total > 0

output:
  stdout:
    format: content
```

## See Also

- [Switch Processor](./switch.md) - Conditional processor chains
- [Mapping Processor](./mapping.md) - JSONata transformations
- [Dedupe Processor](./dedupe.md) - Stateful duplicate suppression
