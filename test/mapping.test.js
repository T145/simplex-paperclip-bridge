import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeChatInfo,
  isChatAllowed,
  extractInboundText,
  normalizeInboundItem,
  selectInboundMessages,
  isIssueReference,
  parseRouting,
  sanitizeText,
  buildIssueTitle,
  deriveIssueIdempotencyKey,
  deriveCommentClientRequestId,
  buildIssuePayload,
  buildCommentBody,
  isOwnComment,
  normalizeComment,
  buildSendCommand,
} from "../src/mapping.js";
import { isUuid } from "../src/uuid.js";

const directChatInfo = {
  type: "direct",
  contact: { contactId: 7, localDisplayName: "Tester" },
};
const groupChatInfo = {
  type: "group",
  groupInfo: { groupId: 42, localDisplayName: "Team Room" },
};

function receivedText(text, itemId = 1) {
  return {
    chatDir: { type: "directRcv" },
    meta: { itemId, itemTs: "2026-01-01T00:00:00Z" },
    content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
  };
}

test("normalizeChatInfo maps direct and group chats", () => {
  assert.deepEqual(normalizeChatInfo(directChatInfo), {
    kind: "direct",
    id: "7",
    name: "Tester",
    key: "direct:7",
  });
  assert.deepEqual(normalizeChatInfo(groupChatInfo), {
    kind: "group",
    id: "42",
    name: "Team Room",
    key: "group:42",
  });
  assert.equal(normalizeChatInfo({ type: "local" }), null);
  assert.equal(normalizeChatInfo(null), null);
});

test("isChatAllowed matches by scoped id and by display name", () => {
  const chat = normalizeChatInfo(directChatInfo);
  assert.equal(isChatAllowed(chat, ["direct:7"]), true);
  assert.equal(isChatAllowed(chat, ["group:7"]), false);
  assert.equal(isChatAllowed(chat, ["tester"]), true);
  assert.equal(isChatAllowed(chat, ["TESTER"]), true);
  assert.equal(isChatAllowed(chat, ["someone-else"]), false);
  assert.equal(isChatAllowed(chat, []), false);
});

test("extractInboundText only accepts received text messages", () => {
  assert.equal(extractInboundText(receivedText("hello")), "hello");
  assert.equal(
    extractInboundText({ ...receivedText("hi"), chatDir: { type: "directSnd" } }),
    null
  );
  assert.equal(
    extractInboundText({
      chatDir: { type: "directRcv" },
      content: { type: "rcvMsgContent", msgContent: { type: "image", text: "" } },
    }),
    null
  );
  assert.equal(extractInboundText({ chatDir: { type: "directRcv" } }), null);
});

test("normalizeInboundItem requires an item id", () => {
  const chat = normalizeChatInfo(directChatInfo);
  const item = normalizeInboundItem(chat, receivedText("hello", 5));
  assert.equal(item.itemId, "5");
  assert.equal(item.text, "hello");
  assert.equal(normalizeInboundItem(chat, { chatDir: { type: "directRcv" } }), null);
});

test("selectInboundMessages filters by allowlist and text", () => {
  const event = {
    type: "newChatItems",
    chatItems: [
      { chatInfo: directChatInfo, chatItem: receivedText("first", 1) },
      {
        chatInfo: { type: "direct", contact: { contactId: 99, localDisplayName: "Stranger" } },
        chatItem: receivedText("not allowed", 2),
      },
    ],
  };
  const selected = selectInboundMessages(event, ["direct:7"]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].text, "first");
  assert.deepEqual(selectInboundMessages({ type: "other" }, ["direct:7"]), []);
});

test("isIssueReference accepts identifiers and UUIDs", () => {
  assert.equal(isIssueReference("API-1001"), true);
  assert.equal(isIssueReference("api-1001"), true);
  assert.equal(isIssueReference("f1b4b6c2-7e3a-4c9d-9a1e-2b6f0d5c8a71"), true);
  assert.equal(isIssueReference("hello"), false);
  assert.equal(isIssueReference("#API-1"), false);
});

test("parseRouting extracts a leading reference and body", () => {
  assert.deepEqual(parseRouting("#API-1001 please look", "#"), {
    reference: "API-1001",
    body: "please look",
  });
  assert.deepEqual(parseRouting("#API-1001", "#"), { reference: "API-1001", body: "" });
  assert.equal(parseRouting("no prefix here", "#"), null);
  assert.equal(parseRouting("#just a hashtag", "#"), null);
  assert.equal(parseRouting("", "#"), null);
});

test("sanitizeText strips control characters and truncates by bytes", () => {
  assert.equal(sanitizeText("a\u0000b\u0007c"), "abc");
  assert.equal(sanitizeText("line1\r\nline2"), "line1\nline2");
  const truncated = sanitizeText("abcdefghijklmnop", 10);
  assert.ok(truncated.startsWith("abcdefghij"));
  assert.ok(truncated.endsWith("[truncated]"));
});

test("buildIssueTitle uses the first non-empty line", () => {
  assert.equal(buildIssueTitle("Title line\nmore", "Tester"), "Title line");
  assert.equal(buildIssueTitle("   \n  ", "Tester"), "Message from Tester");
  assert.equal(buildIssueTitle("", null), "Message from SimpleX");
});

test("idempotency keys are stable and derived from chat and item", () => {
  const chat = normalizeChatInfo(directChatInfo);
  assert.equal(
    deriveIssueIdempotencyKey(chat, "9"),
    "simplex-bridge:issue:direct:7:9"
  );
  const first = deriveCommentClientRequestId(chat, "9");
  const second = deriveCommentClientRequestId(chat, "9");
  const other = deriveCommentClientRequestId(chat, "10");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.ok(isUuid(first));
});

test("buildIssuePayload includes optional routing fields only when set", () => {
  const chat = normalizeChatInfo(directChatInfo);
  const payload = buildIssuePayload({
    chat,
    text: "hello",
    itemId: "1",
    projectId: "proj",
    assigneeAgentId: "agent-1",
    priority: "high",
  });
  assert.equal(payload.projectId, "proj");
  assert.equal(payload.assigneeAgentId, "agent-1");
  assert.equal(payload.priority, "high");
  assert.equal(payload.idempotencyKey, "simplex-bridge:issue:direct:7:1");

  const minimal = buildIssuePayload({ chat, text: "hi", itemId: "2", projectId: "proj" });
  assert.equal("assigneeAgentId" in minimal, false);
  assert.equal("priority" in minimal, false);
});

test("buildCommentBody attributes the source chat", () => {
  const chat = normalizeChatInfo(directChatInfo);
  assert.match(buildCommentBody("body text", chat), /body text/);
  assert.match(buildCommentBody("body text", chat), /Tester/);
});

test("isOwnComment detects bridge-authored comments", () => {
  assert.equal(isOwnComment({ authorAgentId: "bridge-agent" }, "bridge-agent"), true);
  assert.equal(isOwnComment({ authorAgentId: "other" }, "bridge-agent"), false);
  assert.equal(isOwnComment(null, "bridge-agent"), false);
});

test("normalizeComment coerces fields", () => {
  const comment = normalizeComment({ id: 12, body: "x", authorAgentId: null });
  assert.equal(comment.id, "12");
  assert.equal(comment.body, "x");
  assert.equal(normalizeComment(null), null);
});

test("buildSendCommand targets direct and group chats", () => {
  const direct = normalizeChatInfo(directChatInfo);
  const group = normalizeChatInfo(groupChatInfo);
  assert.equal(
    buildSendCommand(direct, "hello"),
    '/_send @7 json [{"msgContent":{"type":"text","text":"hello"}}]'
  );
  assert.equal(
    buildSendCommand(group, "hi"),
    '/_send #42 json [{"msgContent":{"type":"text","text":"hi"}}]'
  );
});
