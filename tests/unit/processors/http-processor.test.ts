import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { createHttpProcessor } from "../../../src/processors/http-processor.js";
import { createMessage } from "../../../src/core/types.js";
describe("HttpProcessor", () => {
  describe("Configuration Validation", () => {
    it("should create processor with valid GET configuration", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/users",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should create processor with JSONata URL template", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/users/{{ content.userId }}",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should create processor with POST and body", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/validate",
          method: "POST",
          body: "{{ content }}",
        }),
      ).not.toThrow();
    });

    it("should create processor with result_key", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultKey: "api_data",
        }),
      ).not.toThrow();
    });

    it("should create processor with result_mapping", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultMapping: '{ $: $, "enriched": http_response }',
        }),
      ).not.toThrow();
    });

    it("should support Bearer authentication", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/protected",
          method: "GET",
          auth: {
            type: "bearer",
            token: "secret-token",
          },
        }),
      ).not.toThrow();
    });

    it("should support Basic authentication", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/protected",
          method: "GET",
          auth: {
            type: "basic",
            username: "admin",
            password: "secret",
          },
        }),
      ).not.toThrow();
    });

    it("should support custom headers", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          headers: {
            "X-API-Key": "my-key",
            "X-Request-ID": "123",
          },
        }),
      ).not.toThrow();
    });

    it("should support timeout configuration", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          timeout: 5000,
        }),
      ).not.toThrow();
    });

    it("should support retry configuration", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          maxRetries: 5,
        }),
      ).not.toThrow();
    });

    it("should fail with empty URL", () => {
      expect(() =>
        createHttpProcessor({
          url: "",
          method: "GET",
        }),
      ).toThrow();
    });

    it("should fail with negative timeout", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          timeout: -1,
        }),
      ).toThrow();
    });

    it("should fail with negative maxRetries", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          maxRetries: -1,
        }),
      ).toThrow();
    });

    it("should fail when Bearer auth missing token", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/protected",
          method: "GET",
          auth: {
            type: "bearer",
          } as any,
        }),
      ).toThrow();
    });

    it("should fail when Basic auth missing credentials", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/protected",
          method: "GET",
          auth: {
            type: "basic",
            username: "admin",
          } as any,
        }),
      ).toThrow();
    });

    it("should fail with invalid result_mapping JSONata", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultMapping: "{ invalid syntax ]][",
        }),
      ).toThrow();
    });
  });

  describe("Component Structure", () => {
    it("should have correct processor name", () => {
      const processor = createHttpProcessor({
        url: "https://api.example.com/test",
        method: "GET",
      });

      expect(processor.name).toBe("http-processor");
    });

    it("should have process method", () => {
      const processor = createHttpProcessor({
        url: "https://api.example.com/test",
        method: "GET",
      });

      expect(processor.process).toBeDefined();
      expect(typeof processor.process).toBe("function");
    });
  });

  describe("Method Support", () => {
    it("should support GET method", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should support POST method", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "POST",
        }),
      ).not.toThrow();
    });

    it("should support PUT method", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "PUT",
        }),
      ).not.toThrow();
    });

    it("should support PATCH method", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "PATCH",
        }),
      ).not.toThrow();
    });

    it("should default to GET when method not specified", () => {
      const processor = createHttpProcessor({
        url: "https://api.example.com/data",
      });

      expect(processor).toBeDefined();
    });
  });

  describe("Template Configuration", () => {
    it("should accept simple URLs without templates", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/static/endpoint",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should accept URLs with single template variable", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/users/{{ content.id }}",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should accept URLs with multiple template variables", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/{{ content.resource }}/{{ content.id }}",
          method: "GET",
        }),
      ).not.toThrow();
    });

    it("should accept complex JSONata expressions in templates", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/{{ content.resource & '/' & content.id }}",
          method: "GET",
        }),
      ).not.toThrow();
    });
  });

  describe("Response Handling Configuration", () => {
    it("should use default result_key when not specified", () => {
      const processor = createHttpProcessor({
        url: "https://api.example.com/data",
        method: "GET",
      });

      expect(processor).toBeDefined();
      // Default resultKey is "http_response"
    });

    it("should accept custom result_key", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultKey: "custom_data",
        }),
      ).not.toThrow();
    });

    it("should accept result_mapping for inline transformation", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultMapping: '{ "value": http_response.data }',
        }),
      ).not.toThrow();
    });

    it("should allow both result_key and result_mapping", () => {
      expect(() =>
        createHttpProcessor({
          url: "https://api.example.com/data",
          method: "GET",
          resultKey: "raw_data",
          resultMapping: '{ "processed": http_response }',
        }),
      ).not.toThrow();
    });
  });

  describe("Concurrent result mapping", () => {
    const startEchoServer = async (): Promise<{
      server: Server;
      baseUrl: string;
    }> => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          let body: unknown = bodyText;
          try {
            body = JSON.parse(bodyText);
          } catch {
            // keep raw text
          }

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              echo: body,
              path: req.url,
            }),
          );
        });
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
      };
    };

    it("should keep result_mapping bindings isolated under concurrency", async () => {
      const { server, baseUrl } = await startEchoServer();

      try {
        const processor = createHttpProcessor({
          url: `${baseUrl}/echo`,
          method: "POST",
          body: '{"workerId":{{$content.workerId}},"token":"{{$content.token}}"}',
          resultMapping: `{
            "workerId": $content.workerId,
            "token": $content.token,
            "boundMessageId": $message.id,
            "boundSource": $meta.source,
            "boundContentToken": $content.token,
            "responseWorkerId": $http_response.echo.workerId,
            "responseToken": $http_response.echo.token
          }`,
          timeout: 5000,
          maxRetries: 0,
        });

        const messages = Array.from({ length: 20 }, (_, index) =>
          createMessage(
            { workerId: index, token: `token-${index}` },
            { source: `source-${index}` },
          ),
        );

        const results = await Effect.runPromise(
          Effect.forEach(messages, (message) => processor.process(message), {
            concurrency: 10,
          }),
        );

        expect(results).toHaveLength(messages.length);

        for (let index = 0; index < messages.length; index++) {
          const source = messages[index];
          const result = results[index];

          expect(result.id).toBe(source.id);
          expect(result.content.workerId).toBe(index);
          expect(result.content.token).toBe(`token-${index}`);
          expect(result.content.boundMessageId).toBe(source.id);
          expect(result.content.boundSource).toBe(`source-${index}`);
          expect(result.content.boundContentToken).toBe(`token-${index}`);
          expect(result.content.responseWorkerId).toBe(index);
          expect(result.content.responseToken).toBe(`token-${index}`);
          expect(result.metadata.httpProcessorApplied).toBe(true);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
});
