import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import {
  createHttpOutput,
  HttpOutputError,
} from "../../../src/outputs/http-output.js";
import { createMessage } from "../../../src/core/types.js";

describe("HttpOutput", () => {
  describe("Configuration Validation", () => {
    it("should create output with valid POST configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "POST",
        }),
      ).not.toThrow();
    });

    it("should create output with valid PUT configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "PUT",
        }),
      ).not.toThrow();
    });

    it("should create output with valid PATCH configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "PATCH",
        }),
      ).not.toThrow();
    });

    it("should default to POST when method not specified", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
        }),
      ).not.toThrow();
    });

    it("should validate HTTP URL format", () => {
      expect(() =>
        createHttpOutput({
          url: "not-a-valid-url",
        }),
      ).toThrow();
    });

    it("should accept HTTP URLs", () => {
      expect(() =>
        createHttpOutput({
          url: "http://example.com/webhook",
        }),
      ).not.toThrow();
    });

    it("should accept HTTPS URLs", () => {
      expect(() =>
        createHttpOutput({
          url: "https://example.com/webhook",
        }),
      ).not.toThrow();
    });

    it("should support custom headers configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "POST",
          headers: {
            "X-Custom-Header": "custom-value",
            "X-Request-ID": "123",
          },
        }),
      ).not.toThrow();
    });

    it("should support Bearer authentication", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "POST",
          auth: {
            type: "bearer",
            token: "test-token-123",
          },
        }),
      ).not.toThrow();
    });

    it("should support Basic authentication", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          method: "POST",
          auth: {
            type: "basic",
            username: "testuser",
            password: "testpass",
          },
        }),
      ).not.toThrow();
    });

    it("should throw on missing bearer token", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          auth: {
            type: "bearer",
            // Missing token
          } as any,
        }),
      ).toThrow("Bearer token required");
    });

    it("should throw on missing basic auth credentials", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          auth: {
            type: "basic",
            username: "testuser",
            // Missing password
          } as any,
        }),
      ).toThrow("Username and password required");
    });

    it("should support timeout configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          timeout: 10000,
        }),
      ).not.toThrow();
    });

    it("should support retry configuration", () => {
      expect(() =>
        createHttpOutput({
          url: "https://webhook.site/test",
          maxRetries: 5,
        }),
      ).not.toThrow();
    });
  });

  describe("Component Structure", () => {
    it("should have correct component name", () => {
      const output = createHttpOutput({
        url: "https://webhook.site/test",
      });

      expect(output.name).toBe("http-output");
    });

    it("should have send method", () => {
      const output = createHttpOutput({
        url: "https://webhook.site/test",
      });

      expect(typeof output.send).toBe("function");
    });

    it("should have close method", () => {
      const output = createHttpOutput({
        url: "https://webhook.site/test",
      });

      expect(typeof output.close).toBe("function");
    });
  });

  describe("HTTP status classification and retry", () => {
    const startStatusServer = async (
      statusCode: number,
    ): Promise<{
      server: Server;
      baseUrl: string;
      getRequestCount: () => number;
    }> => {
      let requestCount = 0;
      const server = createServer((_req, res) => {
        requestCount += 1;
        res.statusCode = statusCode;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: statusCode }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind local HTTP test server");
      }

      return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getRequestCount: () => requestCount,
      };
    };

    const closeServer = async (server: Server): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    };

    it("retries persistent 503 exactly maxRetries + 1 times then fails intermittent", async () => {
      const { server, baseUrl, getRequestCount } = await startStatusServer(503);

      try {
        const maxRetries = 2;
        const output = createHttpOutput({
          url: `${baseUrl}/unavailable`,
          maxRetries,
          timeout: 1000,
        });

        const error = await Effect.runPromise(
          output.send(createMessage({ id: 1 })).pipe(Effect.flip),
        );

        expect(error).toBeInstanceOf(HttpOutputError);
        expect(error.category).toBe("intermittent");
        expect(error.message).toContain("status 503");
        expect(getRequestCount()).toBe(maxRetries + 1);
        expect(output.getMetrics?.().sendErrors).toBe(1);
        expect(output.getMetrics?.().messagesSent).toBe(0);
      } finally {
        await closeServer(server);
      }
    });

    it("fails persistent 404 as logical after exactly one request", async () => {
      const { server, baseUrl, getRequestCount } = await startStatusServer(404);

      try {
        const output = createHttpOutput({
          url: `${baseUrl}/missing`,
          maxRetries: 2,
          timeout: 1000,
        });

        const error = await Effect.runPromise(
          output.send(createMessage({ id: 1 })).pipe(Effect.flip),
        );

        expect(error).toBeInstanceOf(HttpOutputError);
        expect(error.category).toBe("logical");
        expect(error.message).toContain("status 404");
        expect(getRequestCount()).toBe(1);
        expect(output.getMetrics?.().sendErrors).toBe(1);
        expect(output.getMetrics?.().messagesSent).toBe(0);
      } finally {
        await closeServer(server);
      }
    });
  });
});
