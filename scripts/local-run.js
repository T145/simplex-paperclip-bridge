#!/usr/bin/env node
// Local end-to-end run.
//
// Starts a mock SimpleX core and a mock Paperclip API, runs the real bridge
// against them, and proves both directions plus idempotency:
//   1. An allowlisted SimpleX message creates a Paperclip issue.
//   2. Re-sending the same message does not create a second issue.
//   3. A Paperclip reply comment is forwarded back to SimpleX.
//
// Usage: node scripts/local-run.js

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "../src/logger.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import { SimplexClient } from "../src/simplex-client.js";
import { StateStore } from "../src/state-store.js";
import { Bridge } from "../src/bridge.js";
import { createMockCore } from "../tools/mock-simplex-core.js";
import { createMockApi } from "../tools/mock-paperclip-api.js";

const logger = createLogger("info");

function inboundEvent(itemId, text) {
  return {
    type: "newChatItems",
    user: { userId: 1 },
    chatItems: [
      {
        chatInfo: {
          type: "direct",
          contact: { contactId: 7, localDisplayName: "tester" },
        },
        chatItem: {
          chatDir: { type: "directRcv" },
          meta: { itemId, itemTs: new Date().toISOString() },
          content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
        },
      },
    ],
  };
}

async function waitFor(condition, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export async function run() {
  const api = createMockApi({ logger });
  const core = createMockCore({ logger });
  const apiAddress = await api.listen(0);
  const coreAddress = await core.listen();
  const stateDir = await mkdtemp(path.join(tmpdir(), "simplex-bridge-run-"));
  const statePath = path.join(stateDir, "state.json");

  const baseUrl = `http://127.0.0.1:${apiAddress.port}`;
  const config = {
    simplexWsUrl: `ws://127.0.0.1:${coreAddress.port}`,
    paperclipApiUrl: baseUrl,
    paperclipApiToken: "test-token",
    paperclipCompanyId: "test-company",
    paperclipProjectId: "test-project",
    bridgeAgentId: "bridge-agent",
    allowlist: ["direct:7"],
    pollIntervalMs: 60000,
    statePath,
    logLevel: "info",
    issueReferencePrefix: "#",
    defaultAssigneeAgentId: null,
    defaultPriority: null,
    maxMessageBytes: 8000,
    commandTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    retryBaseMs: 50,
    retryMaxMs: 500,
    processedHistoryLimit: 200,
  };

  const paperclip = new PaperclipClient({
    baseUrl,
    token: config.paperclipApiToken,
    companyId: config.paperclipCompanyId,
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
    retries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
  });
  const simplex = new SimplexClient({ url: config.simplexWsUrl, timeoutMs: config.commandTimeoutMs, logger });
  const state = new StateStore(statePath, { historyLimit: config.processedHistoryLimit });
  const bridge = new Bridge({ config, logger, paperclip, simplex, state });

  try {
    await bridge.start();
    assert(await waitFor(() => core.connectionCount > 0), "bridge connected to the mock core");

    // Direction 1: SimpleX -> Paperclip.
    core.emitEvent(inboundEvent(1, "Hello from the phone"));
    assert(
      await waitFor(() => api.issues.size === 1),
      "an allowlisted message created exactly one issue"
    );
    const [issue] = [...api.issues.values()];
    logger.info(`created issue ${issue.identifier}`);

    // Idempotency: the same SimpleX message must not create a second issue.
    core.emitEvent(inboundEvent(1, "Hello from the phone"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(api.issues.size === 1, "re-sending the same message did not create a duplicate issue");

    // A message that names an existing issue becomes a comment.
    core.emitEvent(inboundEvent(2, `#${issue.identifier} following up`));
    assert(
      await waitFor(() => api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/comments")).length >= 1),
      "a routed message added a comment to the named issue"
    );

    // Direction 2: Paperclip -> SimpleX.
    api.addReply(issue.identifier, { body: "Reply from Paperclip", authorAgentId: "some-other-agent" });
    await bridge.pollOnce();
    assert(
      await waitFor(() => core.commands.some((entry) => entry.cmd.startsWith("/_send"))),
      "a Paperclip reply was forwarded back to SimpleX"
    );

    logger.info("local run: PASS");
    return true;
  } finally {
    await bridge.stop().catch(() => {});
    await core.close();
    await api.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`local run: FAIL ${error.stack || error.message}\n`);
      process.exit(1);
    });
}
