## Why

Pipelines currently process every incoming message, including duplicates that can be retried or re-delivered by upstream systems. Adding attribute-based deduplication prevents repeated processing side effects and makes message handling more reliable.

## What Changes

- Add a new `dedupe` processor that can be configured in pipeline YAML.
- Allow users to define which message attribute (or metadata field) is used as the deduplication key.
- Ensure duplicate messages are identified during processing and handled deterministically (for example, skipped from downstream processing).
- Add validation for required dedupe configuration fields and clear errors for invalid setup.
- Add unit and integration coverage for unique vs duplicate message flows.

## Capabilities

### New Capabilities

- `dedupe-processor`: Processor capability that deduplicates messages by a configured attribute key during pipeline processing.

### Modified Capabilities

- None.

## Impact

- Affected code: processor registry/build path, new processor implementation under `src/processors/`, and configuration schema/types under `src/core/`.
- Affected behavior: pipelines can prevent duplicate messages from reaching downstream outputs when configured.
- Affected docs/examples: processor documentation and sample YAML configs need dedupe usage examples.
- Affected testing: new processor unit tests and end-to-end scenarios for duplicate suppression.
