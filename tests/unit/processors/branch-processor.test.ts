import { describe, it, expect } from "vitest";
import { Cause, Effect, Either, Exit, Option } from "effect";
import {
  BranchProcessorError,
  createBranchProcessor,
} from "../../../src/processors/branch-processor.js";
import { createMetadataProcessor } from "../../../src/processors/metadata-processor.js";
import { createMappingProcessor } from "../../../src/processors/mapping-processor.js";
import { createMessage } from "../../../src/core/types.js";

describe("BranchProcessor", () => {
  it("should preserve original message content", async () => {
    const originalContent = { orderId: "123", amount: 100 };
    const message = createMessage(originalContent);

    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor({ addTimestamp: true })],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    // Original content should be unchanged
    expect(result.content).toEqual(originalContent);
    expect(result.id).toBe(message.id);
  });

  it("should execute nested processors and merge result into metadata", async () => {
    const message = createMessage({ orderId: "123", amount: 100 });

    const branchProcessor = createBranchProcessor({
      processors: [
        createMetadataProcessor({ addTimestamp: true }),
        createMappingProcessor({
          expression: "$", // Return entire content as-is
        }),
      ],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    // Original content preserved
    expect(result.content).toEqual({ orderId: "123", amount: 100 });

    // Branch result added to metadata
    expect(result.metadata.branchResult).toBeDefined();
    // Branch should have enriched metadata
    expect(result.metadata.branchResult.metadata.processedAt).toBeDefined();
    // Branch content should be preserved
    expect(result.metadata.branchResult.content).toEqual({
      orderId: "123",
      amount: 100,
    });
  });

  it("should run multiple nested processors sequentially", async () => {
    const message = createMessage({ value: 10 });

    const branchProcessor = createBranchProcessor({
      processors: [
        createMetadataProcessor(),
        createMetadataProcessor({ addTimestamp: true }),
      ],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    // Original unchanged
    expect(result.content).toEqual({ value: 10 });

    // Branch should have both metadata processors applied
    expect(result.metadata.branchResult.metadata.processedBy).toBe(
      "metadata-processor",
    );
    expect(result.metadata.branchResult.metadata.processedAt).toBeDefined();
  });

  it("should isolate branch processing from original message metadata", async () => {
    const message = createMessage(
      { value: 1 },
      { existingMetadata: "original" },
    );

    const branchProcessor = createBranchProcessor({
      processors: [
        createMetadataProcessor({
          addTimestamp: true,
        }),
      ],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    // Original metadata preserved
    expect(result.metadata.existingMetadata).toBe("original");

    // Original metadata should NOT have processedAt
    expect(result.metadata.processedAt).toBeUndefined();

    // Branch result should have processedAt in its metadata
    expect(result.metadata.branchResult.metadata.processedAt).toBeDefined();
  });

  it("should suppress the original when the branch produces no results", async () => {
    const message = createMessage({ value: 1 });
    const branchProcessor = createBranchProcessor({
      processors: [
        {
          name: "suppress",
          process: () => Effect.succeed([]),
        },
      ],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    expect(result).toEqual([]);
  });

  it("should emit one original per branch result in order", async () => {
    const message = createMessage({ original: true }, { existing: "value" });
    const branchProcessor = createBranchProcessor({
      processors: [
        {
          name: "split",
          process: (msg) =>
            Effect.succeed([
              { ...msg, content: { branch: 1 } },
              { ...msg, content: { branch: 2 } },
            ]),
        },
      ],
    });

    const result = await Effect.runPromise(branchProcessor.process(message));

    expect(result).toHaveLength(2);
    expect(result.map((item: any) => item.content)).toEqual([
      { original: true },
      { original: true },
    ]);
    expect(
      result.map((item: any) => item.metadata.branchResult.content.branch),
    ).toEqual([1, 2]);
    expect(
      result.every((item: any) => item.metadata.existing === "value"),
    ).toBe(true);
  });

  it("should preserve undefined content without defecting", async () => {
    const message = createMessage(undefined);
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor({ addTimestamp: true })],
    });

    const either = await Effect.runPromise(
      Effect.either(branchProcessor.process(message)),
    );

    expect(Either.isRight(either)).toBe(true);
    if (Either.isRight(either)) {
      const result = either.right as any;
      expect(result.content).toBeUndefined();
      expect(result.metadata.branchResult.content).toBeUndefined();
    }
  });

  it("should preserve bigint content by type and value", async () => {
    const message = createMessage(1n);
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor()],
    });

    const result = (await Effect.runPromise(
      branchProcessor.process(message),
    )) as any;

    expect(typeof result.content).toBe("bigint");
    expect(result.content).toBe(1n);
    expect(typeof result.metadata.branchResult.content).toBe("bigint");
    expect(result.metadata.branchResult.content).toBe(1n);
  });

  it("should preserve Date content as a Date instance, not a string", async () => {
    const date = new Date(0);
    const message = createMessage(date);
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor()],
    });

    const result = (await Effect.runPromise(
      branchProcessor.process(message),
    )) as any;

    expect(result.content).toBeInstanceOf(Date);
    expect(result.content.getTime()).toBe(0);
    expect(typeof result.content).not.toBe("string");
    expect(result.metadata.branchResult.content).toBeInstanceOf(Date);
    expect(result.metadata.branchResult.content.getTime()).toBe(0);
  });

  it("should clone circular object graphs with isolation", async () => {
    const original: any = {};
    original.self = original;
    const message = createMessage(original);
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor()],
    });

    const result = (await Effect.runPromise(
      branchProcessor.process(message),
    )) as any;

    const branchContent = result.metadata.branchResult.content;
    expect(branchContent.self).toBe(branchContent);
    expect(branchContent).not.toBe(original);
    expect(result.content).toBe(original);
  });

  it("should fail with BranchProcessorError for uncloneable content (not Die)", async () => {
    const message = createMessage({ fn: () => 1 });
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor()],
    });

    const exit = await Effect.runPromise(
      Effect.exit(branchProcessor.process(message)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(BranchProcessorError);
        expect((failure.value as BranchProcessorError)._tag).toBe(
          "BranchProcessorError",
        );
      }
    }

    const either = await Effect.runPromise(
      Effect.either(branchProcessor.process(message)),
    );
    expect(Either.isLeft(either)).toBe(true);
    if (Either.isLeft(either)) {
      expect(either.left).toBeInstanceOf(BranchProcessorError);
    }
  });

  it("should isolate nested mutations from the original message content", async () => {
    const originalContent = { value: 1, nested: { keep: true } };
    const message = createMessage(originalContent);

    const branchProcessor = createBranchProcessor({
      processors: [
        {
          name: "mutate-content",
          process: (msg) =>
            Effect.succeed({
              ...msg,
              content: Object.assign(msg.content as object, {
                value: 999,
                mutated: true,
              }),
            }),
        },
      ],
    });

    const result = (await Effect.runPromise(
      branchProcessor.process(message),
    )) as any;

    // Main content is the original object reference (spread of originalMessage)
    expect(result.content).toBe(originalContent);
    expect(originalContent).toEqual({ value: 1, nested: { keep: true } });
    expect(result.metadata.branchResult.content).toEqual({
      value: 999,
      nested: { keep: true },
      mutated: true,
    });
  });

  it("should expose uncloneable failures on the typed failure channel for DLQ recoverability", async () => {
    const message = createMessage({ fn: () => 1 });
    const branchProcessor = createBranchProcessor({
      processors: [createMetadataProcessor()],
    });

    const exit = await Effect.runPromise(
      Effect.exit(branchProcessor.process(message)),
    );

    // Typed failure (Some) is what pipeline/DLQ handling recovers; defects are not.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(BranchProcessorError);
        expect((failure.value as BranchProcessorError).category).toBe(
          "logical",
        );
      }
      // Confirm it is not only a defect/die without a typed failure
      expect(Cause.isDie(exit.cause)).toBe(false);
    }
  });
});
