## ADDED Requirements

### Requirement: Configurable dedupe processor

The system SHALL provide a `dedupe` processor that can be declared in pipeline configuration and MUST require a configured key selector attribute used to compute a deduplication key per message.

#### Scenario: Valid dedupe configuration is accepted

- **WHEN** a pipeline includes a `dedupe` processor with a valid `key` selector
- **THEN** pipeline configuration validation succeeds

#### Scenario: Missing dedupe key configuration is rejected

- **WHEN** a pipeline includes a `dedupe` processor without a required `key` selector
- **THEN** pipeline build fails with a configuration validation error describing the missing field

### Requirement: Duplicate messages are suppressed by key

The system SHALL evaluate each message against the configured deduplication key and MUST suppress duplicate messages so they do not continue to downstream processors or outputs.

#### Scenario: First message for a key is processed

- **WHEN** a message arrives with a dedupe key value that has not been seen in the active dedupe window
- **THEN** the message continues through the remaining pipeline

#### Scenario: Repeated message for same key is suppressed

- **WHEN** a second message arrives with the same dedupe key value within the active dedupe window
- **THEN** the message is treated as duplicate and is not sent to downstream pipeline steps

### Requirement: Dedupe key extraction from configured attribute

The system SHALL extract the deduplication key from the configured message attribute and MUST fail processing with a typed error when the configured attribute cannot produce a usable key value.

#### Scenario: Key extracted from payload attribute

- **WHEN** `key` references an existing payload attribute
- **THEN** the processor uses that attribute value as the deduplication key

#### Scenario: Key extracted from metadata attribute

- **WHEN** `key` references a metadata attribute
- **THEN** the processor uses that metadata value as the deduplication key

#### Scenario: Key cannot be extracted

- **WHEN** the configured `key` does not exist or resolves to an empty value for a message
- **THEN** processing fails with an error that includes the configured key path and message identifier

### Requirement: Time-bounded dedupe memory

The system MUST apply deduplication within a configured or default retention window and SHALL allow previously seen keys to be processed again after the window expires.

#### Scenario: Key expires from dedupe state

- **WHEN** a message key was previously seen but its retention window has elapsed
- **THEN** a new message with the same key is processed as a new message
