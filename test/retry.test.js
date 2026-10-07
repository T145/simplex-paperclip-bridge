import { test } from "node:test";
import assert from "node:assert/strict";

import { withRetry, backoffDelay, RetryError, isRetryableHttpStatus } from "../src/retry.js";

test("returns immediately when the operation succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retries a retryable failure and then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    },
    {
      retries: 5,
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
      sleep: async (ms) => delays.push(ms),
    }
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("gives up after the configured retries with a RetryError", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("always");
      },
      { retries: 2, sleep: async () => {} }
    ),
    (error) => {
      assert.ok(error instanceof RetryError);
      assert.equal(error.attempts, 3);
      return true;
    }
  );
  assert.equal(calls, 3);
});

test("does not retry a non-retryable error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("fatal");
      },
      { retries: 5, isRetryable: () => false, sleep: async () => {} }
    ),
    /fatal/
  );
  assert.equal(calls, 1);
});

test("backoff grows exponentially and is bounded by maxMs", () => {
  const base = { baseMs: 100, maxMs: 1000, random: () => 1 };
  assert.equal(backoffDelay(0, base), 100);
  assert.equal(backoffDelay(1, base), 200);
  assert.equal(backoffDelay(2, base), 400);
  assert.equal(backoffDelay(10, base), 1000);
  const jittered = backoffDelay(2, { ...base, random: () => 0 });
  assert.equal(jittered, 200);
});

test("isRetryableHttpStatus covers rate limits and server errors", () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(404), false);
});
