import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PaperclipClient } from "../src/paperclip-client.js";
import { SimplexClient } from "../src/simplex-client.js";
import { StateStore } from "../src/state-store.js";
import { Bridge } from "../src/bridge.js";
import { createMockCore } from "../tools/mock-simplex-core.js";
import { createMockApi } from "../tools/mock-paperclip-api.js";

function inboundEvent(itemId, text) {
  return {
    type: "newChatItems",
    user: { userId: 1 },
    chatItems: [
      {
        chatInfo: { type: "direct", contact: { contactId: 7, localDisplayName: "Tester" } },
        chatItem: {
          chatDir: { type: "directRcv" },
          meta: { itemId, itemTs: new Date().toISOString() },
          content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
        },
      },
    ],
  };
}

async function waitFor(condition, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("bridge moves messages in both directions against a mock core", async () => {
  const api = createMockApi();
  const core = createMockCore();
  const apiAddress = await api.listen(0);
  const coreAddress = await core.listen();
  const dir = await mkdtemp(path.join(tmpdir(), "simplex-bridge-it-"));
  const statePath = path.join(dir, "state.json");

  const config = {
    simplexWsUrl: `ws://127.0.0.1:${coreAddress.port}`,
    paperclipApiUrl: `http://127.0.0.1:${apiAddress.port}`,
    paperclipApiToken: "test-token",
    paperclipCompanyId: "test-company",
    paperclipProjectId: "test-project",
    bridgeAgentId: "bridge-agent",
    allowlist: ["direct:7"],
    pollIntervalMs: 60000,
    statePath,
    logLevel: "silent",
    issueReferencePrefix: "#",
    defaultAssigneeAgentId: null,
    defaultPriority: null,
    maxMessageBytes: 8000,
    commandTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    maxRetries: 1,
    retryBaseMs: 20,
    retryMaxMs: 100,
    processedHistoryLimit: 100,
  };

  const paperclip = new PaperclipClient({
    baseUrl: config.paperclipApiUrl,
    token: config.paperclipApiToken,
    companyId: config.paperclipCompanyId,
    requestTimeoutMs: config.requestTimeoutMs,
    retries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
  });
  const simplex = new SimplexClient({
    url: config.simplexWsUrl,
    timeoutMs: config.commandTimeoutMs,
  });
  const state = new StateStore(statePath);
  const bridge = new Bridge({ config, logger: null, paperclip, simplex, state });

  try {
    await bridge.start();
    assert.ok(await waitFor(() => core.connectionCount > 0), "bridge connected");

    core.emitEvent(inboundEvent(1, "Hello from the phone"));
    assert.ok(await waitFor(() => api.issues.size === 1), "issue created");
    const [issue] = [...api.issues.values()];

    core.emitEvent(inboundEvent(1, "Hello from the phone"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(api.issues.size, 1, "no duplicate issue");

    core.emitEvent(inboundEvent(2, `#${issue.identifier} ping`));
    assert.ok(
      await waitFor(
        () =>
          api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/comments")).length >= 1
      ),
      "comment added"
    );

    api.addReply(issue.identifier, { body: "Reply from Paperclip", authorAgentId: "other-agent" });
    await bridge.pollOnce();
    assert.ok(
      await waitFor(() => core.commands.some((entry) => entry.cmd.startsWith("/_send"))),
      "reply forwarded to SimpleX"
    );
  } finally {
    await bridge.stop().catch(() => {});
    await core.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
