import { describe, it, expect } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { Effect, Stream } from "effect";
import {
  createHttpProcessor,
  HttpProcessorError,
} from "../../../src/processors/http-processor.js";
import { run } from "../../../src/core/pipeline.js";
import {
  createMessage,
  type Message,
  type Output,
} from "../../../src/core/types.js";
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

  describe("Documented template context", () => {
    const startCaptureServer = async (): Promise<{
      server: Server;
      baseUrl: string;
      getCaptured: () => {
        method: string;
        url: string;
        headers: IncomingHttpHeaders;
        bodyText: string;
      } | null;
    }> => {
      let captured: {
        method: string;
        url: string;
        headers: IncomingHttpHeaders;
        bodyText: string;
      } | null = null;

      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          captured = {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: req.headers,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          };

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              status: "ok",
              echoUserId: "server-echo",
              total: 42,
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
        getCaptured: () => captured,
      };
    };

    it("resolves unprefixed content/meta/message across URL body headers and result_mapping", async () => {
      const { server, baseUrl, getCaptured } = await startCaptureServer();

      try {
        const msg: Message = {
          ...createMessage(
            {
              orderId: "order-99",
              user: { id: "user-7", name: "Ada" },
              action: "checkout",
            },
            { source: "unit-template-test", region: "us-east-1" },
          ),
          correlationId: "corr-abc-123",
        };

        const processor = createHttpProcessor({
          url: `${baseUrl}/orders/{{content.orderId}}?userId={{content.user.id}}&source={{meta.source}}&messageId={{message.id}}&correlationId={{message.correlationId}}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": "{{content.user.id}}",
            "X-Source": "{{meta.source}}",
            "X-Correlation-Id": "{{message.correlationId}}",
          },
          body: `{
            "orderId": "{{content.orderId}}",
            "userId": "{{content.user.id}}",
            "userName": "{{content.user.name}}",
            "action": "{{content.action}}",
            "messageId": "{{message.id}}",
            "source": "{{meta.source}}"
          }`,
          resultMapping: `{
            "orderId": content.orderId,
            "userId": content.user.id,
            "userName": content.user.name,
            "action": content.action,
            "source": meta.source,
            "region": meta.region,
            "messageId": message.id,
            "correlationId": message.correlationId,
            "apiStatus": http_response.status,
            "apiEchoUserId": http_response.echoUserId,
            "apiTotal": http_response.total
          }`,
          timeout: 5000,
          maxRetries: 0,
        });

        const result = await Effect.runPromise(processor.process(msg));
        const captured = getCaptured();

        expect(captured).not.toBeNull();
        expect(captured!.method).toBe("POST");

        const requestUrl = new URL(captured!.url, baseUrl);
        expect(requestUrl.pathname).toBe("/orders/order-99");
        expect(requestUrl.searchParams.get("userId")).toBe("user-7");
        expect(requestUrl.searchParams.get("source")).toBe("unit-template-test");
        expect(requestUrl.searchParams.get("messageId")).toBe(msg.id);
        expect(requestUrl.searchParams.get("correlationId")).toBe(
          "corr-abc-123",
        );

        // Exact header values — undefined/string "undefined" must fail
        expect(captured!.headers["x-user-id"]).toBe("user-7");
        expect(captured!.headers["x-source"]).toBe("unit-template-test");
        expect(captured!.headers["x-correlation-id"]).toBe("corr-abc-123");

        const requestBody: unknown = JSON.parse(captured!.bodyText);
        expect(requestBody).toEqual({
          orderId: "order-99",
          userId: "user-7",
          userName: "Ada",
          action: "checkout",
          messageId: msg.id,
          source: "unit-template-test",
        });

        // Identity and metadata retained
        expect(result.id).toBe(msg.id);
        expect(result.correlationId).toBe("corr-abc-123");
        expect(result.timestamp).toBe(msg.timestamp);
        expect(result.metadata.source).toBe("unit-template-test");
        expect(result.metadata.region).toBe("us-east-1");
        expect(result.metadata.httpProcessorApplied).toBe(true);

        // Mapped original fields + response fields (empty {} must fail)
        const expectedContent = {
          orderId: "order-99",
          userId: "user-7",
          userName: "Ada",
          action: "checkout",
          source: "unit-template-test",
          region: "us-east-1",
          messageId: msg.id,
          correlationId: "corr-abc-123",
          apiStatus: "ok",
          apiEchoUserId: "server-echo",
          apiTotal: 42,
        };
        expect(result.content).toEqual(expectedContent);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
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

    it("succeeds on 200 and retains message/result behavior", async () => {
      const { server, baseUrl, getRequestCount } = await startStatusServer(200);

      try {
        const processor = createHttpProcessor({
          url: `${baseUrl}/ok`,
          method: "GET",
          resultKey: "http_response",
          timeout: 2000,
          maxRetries: 1,
        });

        const msg = createMessage({ id: "ok-1" }, { source: "status-test" });
        const result = await Effect.runPromise(processor.process(msg));

        expect(result.id).toBe(msg.id);
        expect(result.content).toEqual({ id: "ok-1" });
        expect(result.metadata.source).toBe("status-test");
        expect(result.metadata.httpProcessorApplied).toBe(true);
        expect(result.metadata.http_response).toEqual({ status: 200 });
        expect(getRequestCount()).toBe(1);
      } finally {
        await closeServer(server);
      }
    });

    it("fails 404 as logical after exactly one request despite retries", async () => {
      const { server, baseUrl, getRequestCount } = await startStatusServer(404);

      try {
        const processor = createHttpProcessor({
          url: `${baseUrl}/missing`,
          method: "GET",
          timeout: 2000,
          maxRetries: 1,
        });

        const error = await Effect.runPromise(
          processor.process(createMessage({ id: "missing" })).pipe(Effect.flip),
        );

        expect(error).toBeInstanceOf(HttpProcessorError);
        expect(error.category).toBe("logical");
        expect(error.shouldRetry).toBe(false);
        expect(getRequestCount()).toBe(1);
      } finally {
        await closeServer(server);
      }
    });

    it.each([
      [429, "intermittent"],
      [503, "intermittent"],
    ] as const)(
      "fails %i as %s and makes maxRetries + 1 requests",
      async (statusCode, category) => {
        const { server, baseUrl, getRequestCount } =
          await startStatusServer(statusCode);

        try {
          const maxRetries = 1;
          const processor = createHttpProcessor({
            url: `${baseUrl}/retry`,
            method: "GET",
            timeout: 2000,
            maxRetries,
          });

          const error = await Effect.runPromise(
            processor
              .process(createMessage({ id: `status-${statusCode}` }))
              .pipe(Effect.flip),
          );

          expect(error).toBeInstanceOf(HttpProcessorError);
          expect(error.category).toBe(category);
          expect(error.shouldRetry).toBe(true);
          expect(getRequestCount()).toBe(maxRetries + 1);
        } finally {
          await closeServer(server);
        }
      },
    );

    it("routes terminal HTTP processor failure through pipeline DLQ once", async () => {
      const { server, baseUrl, getRequestCount } = await startStatusServer(404);

      try {
        const primarySends: Message[] = [];
        const dlqSends: Message[] = [];
        const inputMessage = createMessage(
          { orderId: "order-404" },
          { source: "http-dlq-test" },
        );

        const primaryOutput: Output = {
          name: "primary-capture",
          send: (msg) =>
            Effect.sync(() => {
              primarySends.push(msg);
            }),
        };

        const dlqOutput: Output = {
          name: "dlq-capture",
          send: (msg) =>
            Effect.sync(() => {
              dlqSends.push(msg);
            }),
        };

        const result = await Effect.runPromise(
          run({
            name: "http-processor-dlq",
            input: {
              name: "one",
              stream: Stream.make(inputMessage),
            },
            processors: [
              createHttpProcessor({
                url: `${baseUrl}/missing`,
                method: "GET",
                timeout: 2000,
                maxRetries: 1,
              }),
            ],
            output: primaryOutput,
            dlqOutput,
            backpressure: { maxConcurrentMessages: 1 },
          }),
        );

        expect(result.stats.processed).toBe(0);
        expect(result.stats.failed).toBe(1);
        expect(primarySends).toHaveLength(0);
        expect(dlqSends).toHaveLength(1);

        const dlqMessage = dlqSends[0];
        expect(dlqMessage.id).toBe(inputMessage.id);
        expect(dlqMessage.content).toEqual({ orderId: "order-404" });
        expect(dlqMessage.metadata.source).toBe("http-dlq-test");
        expect(dlqMessage.metadata.dlq).toBe(true);
        expect(dlqMessage.metadata.originalMessageId).toBe(inputMessage.id);
        expect(dlqMessage.metadata.dlqAttempts).toBe(1);
        expect(String(dlqMessage.metadata.dlqReason)).toContain(
          "HTTP request failed",
        );
        expect(typeof dlqMessage.metadata.dlqTimestamp).toBe("number");
        expect(getRequestCount()).toBe(1);
        expect(
          result.errors?.some((error) => error instanceof HttpProcessorError),
        ).toBe(true);
      } finally {
        await closeServer(server);
      }
    });
  });
});
