import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, ConfigError } from "../src/config.js";

function baseEnv(overrides = {}) {
  return {
    PAPERCLIP_API_URL: "https://example.invalid/",
    PAPERCLIP_API_TOKEN: "token",
    PAPERCLIP_COMPANY_ID: "company",
    PAPERCLIP_PROJECT_ID: "project",
    BRIDGE_AGENT_ID: "bridge-agent",
    SIMPLEX_ALLOWLIST: "direct:7, group:42 ",
    ...overrides,
  };
}

test("loadConfig applies defaults and parses the allowlist", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.simplexWsUrl, "ws://127.0.0.1:5225");
  assert.equal(config.paperclipApiUrl, "https://example.invalid");
  assert.deepEqual(config.allowlist, ["direct:7", "group:42"]);
  assert.equal(config.pollIntervalMs, 15000);
  assert.equal(config.issueReferencePrefix, "#");
  assert.equal(config.maxMessageBytes, 8000);
});

test("loadConfig reports every missing required variable", () => {
  assert.throws(
    () => loadConfig({}),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((problem) => problem.includes("PAPERCLIP_API_URL")));
      assert.ok(error.problems.some((problem) => problem.includes("SIMPLEX_ALLOWLIST")));
      return true;
    }
  );
});

test("loadConfig rejects an invalid priority", () => {
  assert.throws(
    () => loadConfig(baseEnv({ BRIDGE_DEFAULT_PRIORITY: "urgent" })),
    /BRIDGE_DEFAULT_PRIORITY/
  );
});

test("loadConfig validates URL schemes and retry bounds", () => {
  assert.throws(
    () => loadConfig(baseEnv({ PAPERCLIP_API_URL: "ftp://example.invalid" })),
    /PAPERCLIP_API_URL/
  );
  assert.throws(
    () =>
      loadConfig(
        baseEnv({ BRIDGE_RETRY_BASE_MS: "1000", BRIDGE_RETRY_MAX_MS: "100" })
      ),
    /BRIDGE_RETRY_BASE_MS/
  );
});
