#!/usr/bin/env node
/**
 * Deterministic HTTP request observer for Cascade E2E tests.
 * Records non-admin requests and serves predictable fixtures.
 */
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || "0.0.0.0";

/** @type {Array<{method: string, path: string, query: Record<string, string>, headers: Record<string, string | string[] | undefined>, body: unknown, responseStatus: number}>} */
const requests = [];

/** @type {Map<string, number>} */
const flaky500Counts = new Map();

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {string} pathOnly
 * @param {URLSearchParams} searchParams
 * @param {Buffer} rawBody
 * @returns {{ status: number, body: unknown, record: boolean }}
 */
function handleRoute(req, pathOnly, searchParams, rawBody) {
  const method = (req.method || "GET").toUpperCase();
  const query = Object.fromEntries(searchParams.entries());
  const testId = query.testId;

  let parsedBody = null;
  if (rawBody.length > 0) {
    const text = rawBody.toString("utf8");
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }

  // Admin routes — never recorded
  if (method === "GET" && pathOnly === "/health") {
    return { status: 200, body: { ok: true }, record: false };
  }
  if (method === "GET" && pathOnly === "/__requests") {
    return { status: 200, body: { requests }, record: false };
  }

  // /uuid
  if (method === "GET" && pathOnly === "/uuid") {
    return {
      status: 200,
      body: { uuid: "e2e-uuid", testId: testId ?? null },
      record: true,
    };
  }

  // /post
  if (method === "POST" && pathOnly === "/post") {
    return {
      status: 200,
      body: { json: parsedBody },
      record: true,
    };
  }

  // /get
  if (method === "GET" && pathOnly === "/get") {
    return {
      status: 200,
      body: { args: query },
      record: true,
    };
  }

  // /headers
  if (method === "GET" && pathOnly === "/headers") {
    return {
      status: 200,
      body: { headers: req.headers, testId: testId ?? null },
      record: true,
    };
  }

  // /bearer
  if (method === "GET" && pathOnly === "/bearer") {
    const auth = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) {
      return { status: 401, body: { authenticated: false }, record: true };
    }
    return {
      status: 200,
      body: {
        authenticated: true,
        token: match[1],
        testId: testId ?? null,
      },
      record: true,
    };
  }

  // /basic-auth/:user/:pass
  const basicMatch = /^\/basic-auth\/([^/]+)\/([^/]+)$/.exec(pathOnly);
  if (method === "GET" && basicMatch) {
    const expectedUser = basicMatch[1];
    const expectedPass = basicMatch[2];
    const auth = req.headers.authorization || "";
    const match = /^Basic\s+(.+)$/i.exec(auth);
    if (!match) {
      return { status: 401, body: { authenticated: false }, record: true };
    }
    let decoded = "";
    try {
      decoded = Buffer.from(match[1], "base64").toString("utf8");
    } catch {
      return { status: 401, body: { authenticated: false }, record: true };
    }
    const [user, pass] = decoded.split(":");
    if (user !== expectedUser || pass !== expectedPass) {
      return { status: 401, body: { authenticated: false }, record: true };
    }
    return {
      status: 200,
      body: {
        authenticated: true,
        user: expectedUser,
        testId: testId ?? null,
      },
      record: true,
    };
  }

  // /flaky/500 — first request per testId returns 500, then 200
  if (method === "GET" && pathOnly === "/flaky/500") {
    const key = testId == null ? "__none__" : String(testId);
    const seen = flaky500Counts.get(key) ?? 0;
    flaky500Counts.set(key, seen + 1);
    if (seen === 0) {
      return {
        status: 500,
        body: { error: "flaky", testId: testId ?? null },
        record: true,
      };
    }
    return {
      status: 200,
      body: { recovered: true, testId: testId ?? null },
      record: true,
    };
  }

  // /status/:code
  const statusMatch = /^\/status\/(\d{3})$/.exec(pathOnly);
  if (method === "GET" && statusMatch) {
    const code = Number(statusMatch[1]);
    return {
      status: code,
      body: { status: code, testId: testId ?? null },
      record: true,
    };
  }

  return { status: 404, body: { error: "not found", path: pathOnly }, record: true };
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url || "/", `http://${host}`);
    const pathOnly = url.pathname;
    const rawBody = await readBody(req);
    const result = handleRoute(req, pathOnly, url.searchParams, rawBody);

    if (result.record) {
      let parsedBody = null;
      if (rawBody.length > 0) {
        const text = rawBody.toString("utf8");
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }
      requests.push({
        method: (req.method || "GET").toUpperCase(),
        path: pathOnly,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { ...req.headers },
        body: parsedBody,
        responseStatus: result.status,
      });
    }

    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = JSON.stringify({ error: message });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
});

function shutdown(signal) {
  console.log(`http-test-server received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Force exit if close hangs
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`http-test-server listening on http://${HOST}:${PORT}`);
});
