import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Bridge } from "../src/bridge.js";
import { StateStore } from "../src/state-store.js";
import { isUuid } from "../src/uuid.js";

const directChatInfo = {
  type: "direct",
  contact: { contactId: 7, localDisplayName: "Tester" },
};

function receivedText(text, itemId) {
  return {
    chatDir: { type: "directRcv" },
    meta: { itemId, itemTs: "2026-01-01T00:00:00Z" },
    content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
  };
}

function eventFor(text, itemId = 1, chatInfo = directChatInfo) {
  return {
    type: "newChatItems",
    chatItems: [{ chatInfo, chatItem: receivedText(text, itemId) }],
  };
}

function fakePaperclip() {
  let counter = 1000;
  return {
    created: [],
    added: [],
    commentsByIssue: {},
    async createIssue(payload) {
      counter += 1;
      const issue = { id: `issue-${counter}`, identifier: `API-${counter}`, ...payload };
      this.created.push(issue);
      return issue;
    },
    async addComment(ref, { body, clientRequestId }) {
      const comment = { id: `comment-${this.added.length + 1}`, body, clientRequestId };
      this.added.push({ ref, ...comment });
      return comment;
    },
    async listComments(ref, { after } = {}) {
      const list = this.commentsByIssue[ref] ?? [];
      if (!after) return list;
      const index = list.findIndex((comment) => comment.id === after);
      return index === -1 ? list : list.slice(index);
    },
  };
}

function fakeSimplex() {
  return {
    handlers: new Set(),
    sent: [],
    onEvent(handler) {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    },
    async start() {},
    async stop() {},
    async sendCommand(command) {
      this.sent.push(command);
      return { type: "newChatItems", chatItems: [] };
    },
    emit(resp) {
      for (const handler of this.handlers) handler(resp);
    },
  };
}

function baseConfig(statePath) {
  return {
    simplexWsUrl: "ws://127.0.0.1:5225",
    paperclipApiUrl: "http://127.0.0.1:9",
    paperclipApiToken: "t",
    paperclipCompanyId: "c",
    paperclipProjectId: "project-1",
    bridgeAgentId: "bridge-agent",
    allowlist: ["direct:7"],
    pollIntervalMs: 60000,
    statePath,
    logLevel: "silent",
    issueReferencePrefix: "#",
    defaultAssigneeAgentId: "assignee-1",
    defaultPriority: "medium",
    maxMessageBytes: 8000,
    commandTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    maxRetries: 0,
    retryBaseMs: 10,
    retryMaxMs: 20,
    processedHistoryLimit: 100,
  };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "simplex-bridge-test-"));
  const statePath = path.join(dir, "state.json");
  const paperclip = fakePaperclip();
  const simplex = fakeSimplex();
  const state = new StateStore(statePath);
  await state.load();
  const bridge = new Bridge({
    config: baseConfig(statePath),
    logger: null,
    paperclip,
    simplex,
    state,
  });
  return {
    dir,
    bridge,
    paperclip,
    simplex,
    state,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("an allowlisted message creates an issue and is not duplicated", async () => {
  const ctx = await setup();
  try {
    const results = await ctx.bridge.handleEvent(eventFor("Hello there", 1));
    assert.equal(results[0].status, "created");
    assert.equal(ctx.paperclip.created.length, 1);
    const created = ctx.paperclip.created[0];
    assert.equal(created.projectId, "project-1");
    assert.equal(created.assigneeAgentId, "assignee-1");
    assert.equal(created.priority, "medium");
    assert.equal(created.idempotencyKey, "simplex-bridge:issue:direct:7:1");

    const chat = ctx.state.getChat("direct:7");
    assert.equal(chat.issueIdentifier, created.identifier);

    const second = await ctx.bridge.handleEvent(eventFor("Hello there", 1));
    assert.equal(second[0].status, "duplicate");
    assert.equal(ctx.paperclip.created.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("messages from senders outside the allowlist are ignored", async () => {
  const ctx = await setup();
  try {
    const other = {
      type: "direct",
      contact: { contactId: 99, localDisplayName: "Stranger" },
    };
    const results = await ctx.bridge.handleEvent(eventFor("hello", 1, other));
    assert.deepEqual(results, []);
    assert.equal(ctx.paperclip.created.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("a routed message adds a comment with a deterministic client request id", async () => {
  const ctx = await setup();
  try {
    const results = await ctx.bridge.handleEvent(eventFor("#API-1001 please follow up", 2));
    assert.equal(results[0].status, "commented");
    assert.equal(ctx.paperclip.added.length, 1);
    assert.equal(ctx.paperclip.added[0].ref, "API-1001");
    assert.ok(isUuid(ctx.paperclip.added[0].clientRequestId));
    assert.match(ctx.paperclip.added[0].body, /please follow up/);
    assert.equal(ctx.state.getChat("direct:7").issueIdentifier, "API-1001");
  } finally {
    await ctx.cleanup();
  }
});

test("polling forwards new comments and skips the bridge's own comments", async () => {
  const ctx = await setup();
  try {
    await ctx.state.upsertChat("direct:7", {
      kind: "direct",
      id: "7",
      name: "Tester",
      issueIdentifier: "API-1001",
      lastCommentId: null,
    });
    ctx.paperclip.commentsByIssue["API-1001"] = [
      { id: "c1", body: "reply one", authorAgentId: "some-agent", createdAt: "1" },
      { id: "c2", body: "bridge authored", authorAgentId: "bridge-agent", createdAt: "2" },
      { id: "c3", body: "reply two", authorAgentId: "some-agent", createdAt: "3" },
    ];

    const result = await ctx.bridge.pollChat(ctx.state.getChat("direct:7"));
    assert.equal(result.forwarded, 2);
    assert.equal(ctx.simplex.sent.length, 2);
    assert.match(ctx.simplex.sent[0], /reply one/);
    assert.match(ctx.simplex.sent[1], /reply two/);
    assert.ok(!ctx.simplex.sent.some((command) => command.includes("bridge authored")));
    assert.equal(ctx.state.getChat("direct:7").lastCommentId, "c3");

    const again = await ctx.bridge.pollChat(ctx.state.getChat("direct:7"));
    assert.equal(again.forwarded, 0);
    assert.equal(ctx.simplex.sent.length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("polling tolerates a chat with no issue mapping", async () => {
  const ctx = await setup();
  try {
    await ctx.state.upsertChat("direct:7", { kind: "direct", id: "7" });
    const result = await ctx.bridge.pollChat(ctx.state.getChat("direct:7"));
    assert.equal(result.forwarded, 0);
  } finally {
    await ctx.cleanup();
  }
});
