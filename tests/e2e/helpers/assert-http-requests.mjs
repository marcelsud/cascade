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

/**
 * Take matching requests and ensure no leftovers remain.
 * @param {Array<any>} remaining
 * @param {(r: any) => boolean} pred
 * @param {number} expectedCount
 * @param {string} label
 */
function take(remaining, pred, expectedCount, label) {
  const matched = [];
  const next = [];
  for (const r of remaining) {
    if (pred(r)) matched.push(r);
    else next.push(r);
  }
  assert.equal(
    matched.length,
    expectedCount,
    `${label}: expected ${expectedCount} match(es), got ${matched.length}`,
  );
  remaining.length = 0;
  remaining.push(...next);
  return matched;
}

async function main() {
  const res = await fetch(`${baseUrl}/__requests`);
  if (!res.ok) {
    throw new Error(`Failed to fetch /__requests: HTTP ${res.status}`);
  }
  const payload = await res.json();
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  /** @type {any[]} */
  const remaining = [...requests];

  try {
    switch (scenario) {
      case "output": {
        for (let i = 0; i < 3; i++) {
          const messageId = `http-out-${i}`;
          const matches = take(
            remaining,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              r.body?.content?.messageId === messageId,
            1,
            `POST /post for ${messageId}`,
          );
          const r = matches[0];
          assert.equal(header(r.headers, "x-test-header"), "e2e-test");
          assert.equal(r.body?.content?.content, `HTTP output test ${i}`);
        }
        break;
      }

      case "processor-basic": {
        for (const i of [0, 1]) {
          take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/uuid" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === String(i),
            1,
            `GET /uuid?testId=${i}`,
          );
        }
        break;
      }

      case "processor-post": {
        for (let i = 0; i < 3; i++) {
          const matches = take(
            remaining,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              String(r.body?.order) === String(i),
            1,
            `POST /post for order ${i}`,
          );
          assert.deepEqual(matches[0].body, {
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

          const bearer = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/bearer" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
            1,
            `bearer request for testId=${tid}`,
          );
          assert.equal(
            header(bearer[0].headers, "authorization"),
            "Bearer test-secret-token-12345",
          );

          const headersReq = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/headers" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
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

          const basic = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/basic-auth/testuser/testpass" &&
              r.responseStatus === 200 &&
              String(r.query?.testId) === tid,
            1,
            `basic request for testId=${tid}`,
          );
          assert.equal(
            header(basic[0].headers, "authorization"),
            "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
          );
        }
        break;
      }

      case "processor-errors": {
        for (const tid of ["0", "1"]) {
          const flaky = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/flaky/500" &&
              String(r.query?.testId) === tid,
            2,
            `/flaky/500 for testId=${tid}`,
          ).map((r) => r.responseStatus);
          assert.deepEqual(
            flaky,
            [500, 200],
            `/flaky/500 statuses for testId=${tid}`,
          );

          const notFound = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/status/404" &&
              String(r.query?.testId) === tid,
            1,
            `/status/404 for testId=${tid}`,
          );
          assert.equal(notFound[0].responseStatus, 404);
        }
        break;
      }

      case "processor-retry": {
        for (const tid of ["0", "1"]) {
          const statuses = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/status/503" &&
              String(r.query?.testId) === tid,
            3,
            `/status/503 for testId=${tid}`,
          ).map((r) => r.responseStatus);
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

          const gets = take(
            remaining,
            (r) =>
              r.method === "GET" &&
              r.path === "/get" &&
              r.responseStatus === 200 &&
              r.query?.userId === userId,
            1,
            `GET /get for ${userId}`,
          );
          const getReq = gets[0];
          const messageId = getReq.query?.messageId;
          assert.equal(typeof messageId, "string", `messageId type for ${userId}`);
          assert.notEqual(messageId, "undefined", `messageId concrete for ${userId}`);
          assert.ok(
            typeof messageId === "string" && messageId.length > 0,
            `messageId non-empty for ${userId}`,
          );
          assert.deepEqual(getReq.query, {
            userId,
            action,
            index: userName,
            source: "generate-input",
            messageId,
          });

          const posts = take(
            remaining,
            (r) =>
              r.method === "POST" &&
              r.path === "/post" &&
              r.responseStatus === 200 &&
              r.body?.userId === userId,
            1,
            `POST /post for ${userId}`,
          );
          const postReq = posts[0];
          assert.deepEqual(postReq.body, {
            userId,
            userName,
            action,
            totalPrice: "60",
            itemCount: "3",
          });
          assert.equal(header(postReq.headers, "x-user-id"), userId);
          assert.equal(header(postReq.headers, "x-user-name"), userName);
          assert.equal(header(postReq.headers, "x-action"), action);
          assert.equal(header(postReq.headers, "x-source"), "generate-input");
          assert.equal(header(postReq.headers, "x-message-id"), messageId);
          assert.notEqual(
            header(postReq.headers, "x-message-id"),
            "undefined",
            `POST x-message-id concrete for ${userId}`,
          );
        }
        break;
      }

      default:
        throw new Error(`Unhandled scenario: ${scenario}`);
    }

    assert.equal(
      remaining.length,
      0,
      `unexpected extra HTTP requests remain after scenario ${scenario}`,
    );

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
