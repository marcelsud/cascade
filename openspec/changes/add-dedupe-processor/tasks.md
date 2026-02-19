## 1. Processor and Config Scaffolding

- [x] 1.1 Add `dedupe` processor config schema with required `key` and optional dedupe window/bounds fields in core config types.
- [x] 1.2 Register `dedupe` in processor discriminated union and pipeline builder/registry wiring.
- [x] 1.3 Add validation error messages for missing or invalid dedupe configuration fields.

## 2. Dedupe Processor Implementation

- [x] 2.1 Implement `src/processors/dedupe-processor.ts` using in-memory Effect state keyed by extracted dedupe key.
- [x] 2.2 Implement key extraction logic for payload attribute paths and `metadata.*` selectors.
- [x] 2.3 Implement duplicate suppression path so duplicate messages are not forwarded downstream.
- [x] 2.4 Implement retention-window expiration and max-key eviction behavior to bound memory.
- [x] 2.5 Add processor logging/metrics hooks for dedupe hit/miss and key extraction failures.

## 3. Tests

- [x] 3.1 Add unit tests for config validation success/failure cases for `dedupe`.
- [x] 3.2 Add unit tests for key extraction from payload and metadata attributes.
- [x] 3.3 Add unit tests for duplicate suppression, first-seen pass-through, and expiry reprocessing.
- [x] 3.4 Add unit tests for eviction behavior when dedupe state exceeds configured bounds.
- [x] 3.5 Add integration/e2e test coverage proving duplicates do not reach downstream output.

## 4. Documentation and Examples

- [x] 4.1 Add processor documentation for `dedupe` config, behavior, and scope limitations (process-local only).
- [x] 4.2 Add or update sample YAML configs demonstrating attribute-based deduplication.
- [x] 4.3 Document troubleshooting guidance for missing key extraction and duplicate observability signals.

## 5. Verification

- [x] 5.1 Run unit tests and ensure all dedupe-related tests pass.
- [x] 5.2 Run relevant e2e tests validating downstream duplicate suppression.
- [x] 5.3 Run lint/build checks and confirm no regressions.
