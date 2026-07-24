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
      it("should detect network errors as intermittent", () => {
        const error = new Error("network timeout occurred");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should detect ECONNREFUSED as intermittent", () => {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:6379");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should detect ETIMEDOUT as intermittent", () => {
        const error = new Error("ETIMEDOUT while connecting");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should detect socket errors as intermittent", () => {
        const error = new Error("socket hang up");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should detect connection errors as intermittent", () => {
        const error = new Error("connection refused by server");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should detect ENOTFOUND as intermittent", () => {
        const error = new Error("getaddrinfo ENOTFOUND redis.example.com");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should default to intermittent for unknown errors", () => {
        const error = new Error("some unknown error");
        expect(detectCategory(error)).toBe("intermittent");
      });

      it("should handle undefined cause as intermittent", () => {
        expect(detectCategory(undefined)).toBe("intermittent");
      });

      it("should handle null cause as intermittent", () => {
        expect(detectCategory(null)).toBe("intermittent");
      });
    });

    describe("logical category", () => {
      it("should detect parse errors as logical", () => {
        const error = new Error("Failed to parse JSON");
        expect(detectCategory(error)).toBe("logical");
      });

      it("should detect invalid JSON errors as logical", () => {
        const error = new Error("invalid json in message body");
        expect(detectCategory(error)).toBe("logical");
      });

      it("should detect validation errors as logical", () => {
        const error = new Error("validation failed for field 'age'");
        expect(detectCategory(error)).toBe("logical");
      });

      it("should detect schema errors as logical", () => {
        const error = new Error("schema mismatch detected");
        expect(detectCategory(error)).toBe("logical");
      });

      it("should detect unexpected token errors as logical", () => {
        const error = new Error("Unexpected token } in JSON at position 42");
        expect(detectCategory(error)).toBe("logical");
      });
    });

    describe("fatal category", () => {
      it("should detect required field errors as fatal", () => {
        const error = new Error("required field 'queueUrl' is missing");
        expect(detectCategory(error)).toBe("fatal");
      });

      it("should detect missing config errors as fatal", () => {
        const error = new Error("missing configuration for queue");
        expect(detectCategory(error)).toBe("fatal");
      });

      it("should detect not configured errors as fatal", () => {
        const error = new Error("service not configured properly");
        expect(detectCategory(error)).toBe("fatal");
      });

      it("should detect unauthorized errors as fatal", () => {
        const error = new Error("unauthorized access to resource");
        expect(detectCategory(error)).toBe("fatal");
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
