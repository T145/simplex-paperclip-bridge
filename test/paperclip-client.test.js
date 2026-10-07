import { test } from "node:test";
import assert from "node:assert/strict";

import { PaperclipClient, HttpError } from "../src/paperclip-client.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

function makeClient(fetchImpl, overrides = {}) {
  return new PaperclipClient({
    baseUrl: "http://127.0.0.1:9",
    token: "test-token",
    companyId: "company-1",
    fetchImpl,
    retries: 2,
    retryBaseMs: 10,
    retryMaxMs: 20,
    random: () => 1,
    sleep: async () => {},
    ...overrides,
  });
}

test("createIssue posts the payload with the bearer token", async () => {
  const calls = [];
  const client = makeClient(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(201, { id: "abc", identifier: "API-1001" });
  });
  const issue = await client.createIssue({ title: "hi", projectId: "p" });
  assert.equal(issue.identifier, "API-1001");
  assert.equal(calls[0].url, "http://127.0.0.1:9/api/companies/company-1/issues");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "hi", projectId: "p" });
});

test("addComment includes clientRequestId only when supplied", async () => {
  const calls = [];
  const client = makeClient(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(201, { id: "c1" });
  });
  await client.addComment("API-1001", { body: "hello" });
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: "hello" });
  await client.addComment("API-1001", { body: "hello", clientRequestId: "uuid-1" });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    body: "hello",
    clientRequestId: "uuid-1",
  });
});

test("listComments passes the after cursor and normalizes comments", async () => {
  let seenUrl;
  const client = makeClient(async (url) => {
    seenUrl = url;
    return jsonResponse(200, [
      { id: "c1", body: "one", authorAgentId: "a" },
      { id: "c2", body: "two", authorAgentId: null },
    ]);
  });
  const comments = await client.listComments("API-1001", { after: "c0" });
  assert.ok(seenUrl.includes("after=c0"));
  assert.ok(seenUrl.includes("order=asc"));
  assert.equal(comments.length, 2);
  assert.equal(comments[0].id, "c1");
  assert.equal(comments[1].authorAgentId, null);
});

test("retries a retryable HTTP status and then succeeds", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(503, { error: "busy" });
    return jsonResponse(200, { id: "abc" });
  });
  const result = await client.getIssue("abc");
  assert.equal(result.id, "abc");
  assert.equal(calls, 2);
});

test("does not retry a non-retryable HTTP status", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return jsonResponse(400, { error: "bad" });
  });
  await assert.rejects(() => client.getIssue("abc"), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls, 1);
});

test("retries network errors", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    return jsonResponse(200, { id: "abc" });
  });
  const result = await client.getIssue("abc");
  assert.equal(result.id, "abc");
  assert.equal(calls, 2);
});
