import { describe, it, expect } from "vitest";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
  getErrorCategory,
  isFatalError,
  isIntermittentError,
} from "../../../src/core/errors.js";
import { SqsInputError } from "../../../src/inputs/sqs-input.js";
import { SqsOutputError } from "../../../src/outputs/sqs-output.js";
import { RedisStreamsInputError } from "../../../src/inputs/redis-streams-input.js";
import { RedisOutputError } from "../../../src/outputs/redis-streams-output.js";

describe("Error Categorization", () => {
  describe("detectCategory()", () => {
    describe("intermittent category", () => {
      it.each([
        ["network timeout occurred", "network errors"],
        ["connect ECONNREFUSED 127.0.0.1:6379", "ECONNREFUSED"],
        ["ETIMEDOUT while connecting", "ETIMEDOUT"],
        ["socket hang up", "socket errors"],
        ["connection refused by server", "connection errors"],
        ["getaddrinfo ENOTFOUND redis.example.com", "ENOTFOUND"],
        ["some unknown error", "unknown errors default"],
      ] as const)("classifies %s as intermittent (%s)", (message) => {
        expect(detectCategory(new Error(message))).toBe("intermittent");
      });

      it.each([undefined, null] as const)(
        "classifies %s cause as intermittent",
        (cause) => {
          expect(detectCategory(cause)).toBe("intermittent");
        },
      );
    });

    describe("logical category", () => {
      it.each([
        ["Failed to parse JSON", "parse errors"],
        ["invalid json in message body", "invalid JSON"],
        ["validation failed for field 'age'", "validation errors"],
        ["schema mismatch detected", "schema errors"],
        ["Unexpected token } in JSON at position 42", "unexpected token"],
      ] as const)("classifies %s as logical (%s)", (message) => {
        expect(detectCategory(new Error(message))).toBe("logical");
      });
    });

    describe("fatal category", () => {
      it.each([
        ["required field 'queueUrl' is missing", "required field"],
        ["missing configuration for queue", "missing config"],
        ["service not configured properly", "not configured"],
        ["unauthorized access to resource", "unauthorized"],
      ] as const)("classifies %s as fatal (%s)", (message) => {
        expect(detectCategory(new Error(message))).toBe("fatal");
      });
    });

    describe("non-Error causes", () => {
      it("should handle string causes", () => {
        expect(detectCategory("network timeout")).toBe("intermittent");
        expect(detectCategory("parse error")).toBe("logical");
        expect(detectCategory("required field missing")).toBe("fatal");
      });

      it("should handle object causes", () => {
        const obj = { message: "connection failed" };
        expect(detectCategory(obj)).toBe("intermittent");
      });

      it("classifies plain objects from JSON-stringified message text", () => {
        expect(detectCategory({ reason: "parse failure" })).toBe("logical");
        expect(detectCategory({ detail: "required field missing" })).toBe(
          "fatal",
        );
      });

      it("does not throw when JSON.stringify returns undefined", () => {
        const cause = {
          toJSON: () => undefined,
        };
        expect(detectCategory(cause)).toBe("intermittent");
      });

      it("does not throw when message getter throws", () => {
        const cause = {
          get message(): string {
            throw new Error("getter exploded");
          },
        };
        expect(detectCategory(cause)).toBe("intermittent");
      });
    });
  });

  describe("ComponentError base class", () => {
    it("should provide shouldRetry for intermittent errors", () => {
      const error = new SqsInputError("test", "intermittent");
      expect(error.shouldRetry).toBe(true);
      expect(error.isFatal).toBe(false);
      expect(error.logLevel).toBe("error");
    });

    it("should provide shouldRetry for logical errors", () => {
      const error = new SqsInputError("test", "logical");
      expect(error.shouldRetry).toBe(false);
      expect(error.isFatal).toBe(false);
      expect(error.logLevel).toBe("debug");
    });

    it("should provide isFatal for fatal errors", () => {
      const error = new SqsInputError("test", "fatal");
      expect(error.shouldRetry).toBe(false);
      expect(error.isFatal).toBe(true);
      expect(error.logLevel).toBe("error");
    });
  });

  describe("getErrorCategory()", () => {
    it("prefers an explicit valid category on the error object", () => {
      const error = Object.assign(new Error("network timeout"), {
        category: "logical" as const,
      });
      expect(getErrorCategory(error)).toBe("logical");
      expect(isIntermittentError(error)).toBe(false);
      expect(isFatalError(error)).toBe(false);
    });

    it("honors ComponentError.category values", () => {
      expect(getErrorCategory(new SqsInputError("x", "fatal"))).toBe("fatal");
      expect(isFatalError(new SqsInputError("x", "fatal"))).toBe(true);
      expect(isIntermittentError(new SqsInputError("x", "intermittent"))).toBe(
        true,
      );
    });

    it("falls back to detectCategory for untyped errors", () => {
      expect(getErrorCategory(new Error("Persistent error"))).toBe(
        "intermittent",
      );
      expect(getErrorCategory(new Error("invalid json payload"))).toBe(
        "logical",
      );
      expect(getErrorCategory(new Error("missing required config"))).toBe(
        "fatal",
      );
    });

    it("ignores invalid category fields and falls back", () => {
      const error = Object.assign(new Error("network timeout"), {
        category: "nope",
      });
      expect(getErrorCategory(error)).toBe("intermittent");
    });
  });

  describe("SqsInputError", () => {
    it("should extend ComponentError with correct category", () => {
      const cause = new Error("network timeout");
      const error = new SqsInputError(
        "Failed to poll SQS",
        detectCategory(cause),
        cause,
      );

      expect(error).toBeInstanceOf(ComponentError);
      expect(error).toBeInstanceOf(SqsInputError);
      expect(error._tag).toBe("SqsInputError");
      expect(error.category).toBe("intermittent");
      expect(error.message).toBe("Failed to poll SQS");
      expect(error.cause).toBe(cause);
      expect(error.shouldRetry).toBe(true);
    });

    it("should detect logical errors correctly", () => {
      const cause = new Error("parse error");
      const error = new SqsInputError(
        "Invalid message format",
        detectCategory(cause),
        cause,
      );

      expect(error.category).toBe("logical");
      expect(error.shouldRetry).toBe(false);
      expect(error.logLevel).toBe("debug");
    });
  });

  describe("SqsOutputError", () => {
    it("should extend ComponentError with correct category", () => {
      const cause = new Error("ECONNREFUSED");
      const error = new SqsOutputError(
        "Failed to send to SQS",
        detectCategory(cause),
        cause,
      );

      expect(error).toBeInstanceOf(ComponentError);
      expect(error).toBeInstanceOf(SqsOutputError);
      expect(error._tag).toBe("SqsOutputError");
      expect(error.category).toBe("intermittent");
      expect(error.shouldRetry).toBe(true);
    });
  });

  describe("RedisStreamsInputError", () => {
    it("should extend ComponentError with correct category", () => {
      const cause = new Error("connection timeout");
      const error = new RedisStreamsInputError(
        "Failed to read from Redis",
        detectCategory(cause),
        cause,
      );

      expect(error).toBeInstanceOf(ComponentError);
      expect(error).toBeInstanceOf(RedisStreamsInputError);
      expect(error._tag).toBe("RedisStreamsInputError");
      expect(error.category).toBe("intermittent");
      expect(error.shouldRetry).toBe(true);
    });
  });

  describe("RedisOutputError", () => {
    it("should extend ComponentError with correct category", () => {
      const cause = new Error("socket hang up");
      const error = new RedisOutputError(
        "Failed to send to Redis stream",
        detectCategory(cause),
        cause,
      );

      expect(error).toBeInstanceOf(ComponentError);
      expect(error).toBeInstanceOf(RedisOutputError);
      expect(error._tag).toBe("RedisOutputError");
      expect(error.category).toBe("intermittent");
      expect(error.shouldRetry).toBe(true);
    });
  });

  describe("Error categorization integration", () => {
    it("should auto-detect category from network error", () => {
      const networkError = new Error("ECONNREFUSED 127.0.0.1:9324");
      const error = new SqsOutputError(
        "SQS send failed",
        detectCategory(networkError),
        networkError,
      );

      expect(error.category).toBe("intermittent");
      expect(error.shouldRetry).toBe(true);
    });

    it("should auto-detect category from parse error", () => {
      const parseError = new Error("Unexpected token } in JSON");
      const error = new RedisStreamsInputError(
        "Message parse failed",
        detectCategory(parseError),
        parseError,
      );

      expect(error.category).toBe("logical");
      expect(error.shouldRetry).toBe(false);
      expect(error.logLevel).toBe("debug");
    });

    it("should auto-detect category from config error", () => {
      const configError = new Error("required field 'queueUrl' is missing");
      const error = new SqsInputError(
        "Configuration error",
        detectCategory(configError),
        configError,
      );

      expect(error.category).toBe("fatal");
      expect(error.isFatal).toBe(true);
    });
  });
});
