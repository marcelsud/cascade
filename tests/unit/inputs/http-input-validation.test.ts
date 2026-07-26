import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { Effect, Either } from "effect";
import {
  createHttpInput,
  HttpInputError,
  validateHttpInputConfig,
} from "../../../src/inputs/http-input.js";

const reserveFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a free TCP port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
};

const connectWithRetry = async (
  port: number,
  host: string,
  attempts = 40,
): Promise<Socket> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = createConnection({ port, host });
        const onError = (error: Error) => {
          candidate.destroy();
          reject(error);
        };
        candidate.once("error", onError);
        candidate.once("connect", () => {
          candidate.removeListener("error", onError);
          resolve(candidate);
        });
      });
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to connect to ${host}:${port}`);
};

describe("HTTP input validation", () => {
  it("returns typed validation failures through the error channel", async () => {
    const result = await Effect.runPromise(
      Effect.either(validateHttpInputConfig({ port: 0 })),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HttpInputError);
      expect(result.left.category).toBe("logical");
    }
  });

  it("rejects non-positive maxBodyBytes as a logical validation error", async () => {
    const result = await Effect.runPromise(
      Effect.either(validateHttpInputConfig({ port: 8080, maxBodyBytes: 0 })),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HttpInputError);
      expect(result.left.category).toBe("logical");
    }
  });
});

describe("HTTP input request body timeout", () => {
  // Real wall-clock timing is required: AC measures absolute body-read timeout
  // against incomplete sockets (fake timers cannot exercise Node HTTP I/O).
  it("terminates incomplete bodies with 408 within the configured window", async () => {
    const port = await reserveFreePort();
    expect(port).toBeGreaterThan(0);

    const input = createHttpInput({
      port,
      host: "127.0.0.1",
      path: "/webhook",
      timeout: 100,
    });

    let client: Socket | undefined;
    try {
      client = await connectWithRetry(port, "127.0.0.1");
      client.setEncoding("utf8");

      let raw = "";
      let startedAt = 0;
      let settled = false;

      const responsePromise = new Promise<{
        raw: string;
        elapsedMs: number;
      }>((resolve, reject) => {
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(watchdog);
          if (error) {
            reject(error);
            return;
          }
          resolve({
            raw,
            elapsedMs: Date.now() - startedAt,
          });
        };

        const watchdog = setTimeout(() => {
          finish(new Error("Timed out waiting for HTTP input body timeout"));
        }, 2_000);

        client!.on("data", (chunk) => {
          raw += chunk;
        });
        client!.on("end", () => finish());
        client!.on("close", () => finish());
        client!.on("error", () => finish());
      });

      const payload =
        "POST /webhook HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 100\r\n" +
        "Connection: keep-alive\r\n" +
        "\r\n" +
        "{";

      // Measure from the incomplete-body write; keep the write side open.
      startedAt = Date.now();
      client.write(payload);

      const { raw: responseRaw, elapsedMs } = await responsePromise;
      expect(input.getMetrics?.()).toMatchObject({
        errorsEncountered: 1,
        messagesProcessed: 0,
      });

      expect(responseRaw).toMatch(/HTTP\/1\.1 408/);
      expect(responseRaw.toLowerCase()).toContain("connection: close");
      expect(elapsedMs).toBeGreaterThanOrEqual(100);
      expect(elapsedMs).toBeLessThanOrEqual(350);
    } finally {
      if (client && !client.destroyed) {
        client.destroy();
      }
      await Effect.runPromise(input.close());
    }
  }, 10_000);
});

describe("HTTP input request body limit", () => {
  const waitForHttpResponse = (
    client: Socket,
    timeoutMs = 2_000,
  ): Promise<string> => {
    let raw = "";
    let settled = false;

    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(watchdog);
        if (error) {
          reject(error);
          return;
        }
        resolve(raw);
      };

      const watchdog = setTimeout(() => {
        finish(
          new Error("Timed out waiting for HTTP input body-limit response"),
        );
      }, timeoutMs);

      client.on("data", (chunk) => {
        raw += chunk;
      });
      client.on("end", () => finish());
      client.on("close", () => finish());
      client.on("error", () => finish());
    });
  };

  it("rejects declared Content-Length above the limit with 413 before buffering", async () => {
    const port = await reserveFreePort();
    const maxBodyBytes = 64;
    const input = createHttpInput({
      port,
      host: "127.0.0.1",
      path: "/webhook",
      maxBodyBytes,
    });

    let client: Socket | undefined;
    try {
      client = await connectWithRetry(port, "127.0.0.1");
      client.setEncoding("utf8");

      // Attach readers before writing so 413-then-destroy is still readable.
      const responsePromise = waitForHttpResponse(client);

      const payload =
        "POST /webhook HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${maxBodyBytes * 100}\r\n` +
        "Connection: keep-alive\r\n" +
        "\r\n" +
        "x".repeat(maxBodyBytes * 100);

      client.write(payload);

      const responseRaw = await responsePromise;
      expect(responseRaw).toMatch(/HTTP\/1\.1 413/);
      expect(responseRaw.toLowerCase()).toContain("connection: close");
      expect(input.getMetrics?.()).toMatchObject({
        errorsEncountered: 1,
        messagesProcessed: 0,
      });
    } finally {
      if (client && !client.destroyed) {
        client.destroy();
      }
      await Effect.runPromise(input.close());
    }
  }, 10_000);

  it("stops accumulating a chunked body once the limit is crossed", async () => {
    const port = await reserveFreePort();
    const maxBodyBytes = 64;
    const input = createHttpInput({
      port,
      host: "127.0.0.1",
      path: "/webhook",
      maxBodyBytes,
    });

    let client: Socket | undefined;
    try {
      client = await connectWithRetry(port, "127.0.0.1");
      client.setEncoding("utf8");

      const responsePromise = waitForHttpResponse(client);

      // Two 50-byte chunks (100 bytes total) exceed maxBodyBytes=64.
      const chunk1 = "a".repeat(50);
      const chunk2 = "b".repeat(50);
      const toChunk = (data: string) =>
        `${data.length.toString(16)}\r\n${data}\r\n`;

      const payload =
        "POST /webhook HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: text/plain\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Connection: keep-alive\r\n" +
        "\r\n" +
        toChunk(chunk1) +
        toChunk(chunk2) +
        "0\r\n\r\n";

      client.write(payload);

      const responseRaw = await responsePromise;
      expect(responseRaw).toMatch(/HTTP\/1\.1 413/);
      expect(responseRaw.toLowerCase()).toContain("connection: close");
      expect(input.getMetrics?.()).toMatchObject({
        errorsEncountered: 1,
        messagesProcessed: 0,
      });
    } finally {
      if (client && !client.destroyed) {
        client.destroy();
      }
      await Effect.runPromise(input.close());
    }
  }, 10_000);

  it("accepts a body of exactly the configured limit", async () => {
    const port = await reserveFreePort();
    const maxBodyBytes = 64;
    const input = createHttpInput({
      port,
      host: "127.0.0.1",
      path: "/webhook",
      maxBodyBytes,
    });

    let client: Socket | undefined;
    try {
      client = await connectWithRetry(port, "127.0.0.1");
      client.setEncoding("utf8");

      const responsePromise = waitForHttpResponse(client);

      // Exactly maxBodyBytes of JSON-valid content (quoted string of length 62 + quotes = 64).
      const body = `"${"x".repeat(maxBodyBytes - 2)}"`;
      expect(Buffer.byteLength(body)).toBe(maxBodyBytes);

      const payload =
        "POST /webhook HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${maxBodyBytes}\r\n` +
        "Connection: close\r\n" +
        "\r\n" +
        body;

      client.write(payload);

      const responseRaw = await responsePromise;
      expect(responseRaw).toMatch(/HTTP\/1\.1 200/);
      expect(input.getMetrics?.()).toMatchObject({
        errorsEncountered: 0,
        messagesProcessed: 1,
      });
    } finally {
      if (client && !client.destroyed) {
        client.destroy();
      }
      await Effect.runPromise(input.close());
    }
  }, 10_000);

  // Enforcement is per-request and follows HTTP framing; surplus octets past
  // Content-Length are a pipelined request bounded by Node's header limit, not
  // unbounded body accumulation.
  it("frames an under-declared Content-Length at the declared length and rejects surplus octets", async () => {
    const port = await reserveFreePort();
    const maxBodyBytes = 64;
    const input = createHttpInput({
      port,
      host: "127.0.0.1",
      path: "/webhook",
      maxBodyBytes,
    });

    let client: Socket | undefined;
    try {
      client = await connectWithRetry(port, "127.0.0.1");
      client.setEncoding("utf8");

      // Attach readers before writing so 400-then-destroy is still readable.
      const responsePromise = waitForHttpResponse(client);

      const body = "x".repeat(60);
      const surplus = "y".repeat(256 * 1024); // ~256 KiB past declared length
      const payload =
        "POST /webhook HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: text/plain\r\n" +
        "Content-Length: 60\r\n" +
        "Connection: keep-alive\r\n" +
        "\r\n" +
        body +
        surplus;

      client.write(payload);

      const responseRaw = await responsePromise;
      expect(responseRaw).toMatch(/HTTP\/1\.1 400/);
      expect(input.getMetrics?.()).toMatchObject({
        errorsEncountered: 0,
        messagesProcessed: 1,
      });
    } finally {
      if (client && !client.destroyed) {
        client.destroy();
      }
      await Effect.runPromise(input.close());
    }
  }, 10_000);
});
