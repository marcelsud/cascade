#!/usr/bin/env node
/**
 * Assert recorded HTTP observer requests for a named E2E scenario.
 *
 * Usage: node tests/e2e/helpers/assert-http-requests.mjs <scenario>
 */
import assert from "node:assert/strict";

const scenario = process.argv[2];
const baseUrl = process.env.CASCADE_E2E_HTTP_URL || "http://127.0.0.1:8081";

const allowed = new Set([
  "output",
  "processor-basic",
  "processor-post",
  "processor-auth",
  "processor-errors",
  "processor-retry",
  "processor-templates",
]);

if (!scenario || !allowed.has(scenario)) {
  console.error(
    `Usage: node tests/e2e/helpers/assert-http-requests.mjs <${[...allowed].join("|")}>`,
  );
  process.exit(2);
}

/**
 * @param {unknown} actual
 * @param {string} label
 */
function dumpFail(actual, label) {
  console.error(`\nHTTP request assertion failed: ${label}`);
  console.error(JSON.stringify(actual, null, 2));
}

/**
 * @param {Array<any>} requests
 * @param {(r: any) => boolean} pred
 */
function filter(requests, pred) {
  return requests.filter(pred);
}

/**
 * @param {any} headers
 * @param {string} name
 */
function header(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

async function main() {
  const res = await fetch(`${baseUrl}/__requests`);
  if (!res.ok) {
    throw new Error(`Failed to fetch /__requests: HTTP ${res.status}`);
  }
  const payload = await res.json();
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];

  try {
    switch (scenario) {
      case "output": {
        for (let i = 0; i < 3; i++) {
          const messageId = `http-out-${i}`;
          const matches = filter(
            requests,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              r.body?.content?.messageId === messageId,
          );
          assert.equal(
            matches.length,
            1,
            `expected exactly one POST /post for ${messageId}`,
          );
          const r = matches[0];
          assert.equal(header(r.headers, "x-test-header"), "e2e-test");
          assert.equal(r.body?.content?.content, `HTTP output test ${i}`);
        }
        break;
      }

      case "processor-basic": {
        for (const i of [0, 1]) {
          const matches = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/uuid" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === String(i),
          );
          assert.equal(
            matches.length,
            1,
            `expected exactly one GET /uuid?testId=${i}`,
          );
        }
        break;
      }

      case "processor-post": {
        for (let i = 0; i < 3; i++) {
          const matches = filter(
            requests,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              String(r.body?.order) === String(i),
          );
          assert.equal(
            matches.length,
            1,
            `expected exactly one POST /post for order ${i}`,
          );
          const body = matches[0].body;
          assert.deepEqual(body, {
            order: String(i),
            product: `widget-${i}`,
            qty: i + 1,
          });
        }
        break;
      }

      case "processor-auth": {
        for (let i = 0; i < 3; i++) {
          const tid = String(i);

          const bearer = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/bearer" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
          );
          assert.equal(bearer.length, 1, `bearer request for testId=${tid}`);
          assert.equal(
            header(bearer[0].headers, "authorization"),
            "Bearer test-secret-token-12345",
          );

          const headersReq = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/headers" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
          );
          assert.equal(
            headersReq.length,
            1,
            `headers request for testId=${tid}`,
          );
          assert.equal(
            header(headersReq[0].headers, "x-api-key"),
            "my-api-key-67890",
          );
          assert.equal(
            header(headersReq[0].headers, "x-request-id"),
            `test-${tid}`,
          );

          const basic = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/basic-auth/testuser/testpass" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
          );
          assert.equal(basic.length, 1, `basic request for testId=${tid}`);
          assert.equal(
            header(basic[0].headers, "authorization"),
            "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
          );
        }
        break;
      }

      case "processor-errors": {
        for (const tid of ["0", "1"]) {
          const flaky = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/flaky/500" &&
              String(r.query?.testId) === tid,
          ).map((r) => r.responseStatus);
          assert.deepEqual(
            flaky,
            [500, 200],
            `/flaky/500 statuses for testId=${tid}`,
          );

          const notFound = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/status/404" &&
              String(r.query?.testId) === tid,
          );
          assert.equal(
            notFound.length,
            1,
            `exactly one /status/404 for testId=${tid}`,
          );
          assert.equal(notFound[0].responseStatus, 404);
        }
        break;
      }

      case "processor-retry": {
        for (const tid of ["0", "1"]) {
          const statuses = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/status/503" &&
              String(r.query?.testId) === tid,
          ).map((r) => r.responseStatus);
          assert.equal(
            statuses.length,
            3,
            `exactly three /status/503 for testId=${tid}`,
          );
          assert.ok(
            statuses.every((s) => s === 503),
            `all /status/503 responses are 503 for testId=${tid}`,
          );
        }
        break;
      }

      case "processor-templates": {
        for (let i = 0; i < 3; i++) {
          const userId = `user-${i}`;
          const userName = `Test User ${i}`;
          const action = `action-${i}`;

          const gets = filter(
            requests,
            (r) =>
              r.method === "GET" &&
              r.path === "/get" &&
              r.responseStatus === 200 &&
              r.query?.userId === userId,
          );
          assert.equal(gets.length, 1, `GET /get for ${userId}`);
          assert.deepEqual(gets[0].query, {
            userId,
            action,
            index: userName,
          });

          const posts = filter(
            requests,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              r.body?.userId === userId,
          );
          assert.equal(posts.length, 1, `POST /post for ${userId}`);
          assert.deepEqual(posts[0].body, {
            userId,
            userName,
            action,
            totalPrice: "60",
            itemCount: "3",
          });
        }
        break;
      }

      default:
        throw new Error(`Unhandled scenario: ${scenario}`);
    }

    console.log(`✓ HTTP request assertions passed for scenario: ${scenario}`);
  } catch (error) {
    dumpFail(requests, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
