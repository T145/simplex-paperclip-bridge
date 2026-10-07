// Pure message mapping between the SimpleX core WebSocket protocol and the
// Paperclip public API. Everything here is side effect free so it can be unit
// tested without a network.

import { uuidv5, isUuid } from "./uuid.js";

const RECEIVE_DIRECTIONS = new Set(["directRcv", "groupRcv", "channelRcv"]);
const ISSUE_REFERENCE_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

// --- chat identity ---------------------------------------------------------

export function normalizeChatInfo(chatInfo) {
  if (!chatInfo || typeof chatInfo !== "object") return null;
  if (chatInfo.type === "direct" && chatInfo.contact) {
    const contact = chatInfo.contact;
    return {
      kind: "direct",
      id: String(contact.contactId),
      name: contact.localDisplayName ?? null,
      key: `direct:${contact.contactId}`,
    };
  }
  if (chatInfo.type === "group" && chatInfo.groupInfo) {
    const group = chatInfo.groupInfo;
    return {
      kind: "group",
      id: String(group.groupId),
      name: group.localDisplayName ?? null,
      key: `group:${group.groupId}`,
    };
  }
  return null;
}

export function isChatAllowed(chat, allowlist) {
  if (!chat) return false;
  const entries = Array.isArray(allowlist) ? allowlist : [];
  for (const raw of entries) {
    const entry = String(raw ?? "").trim();
    if (entry === "") continue;
    if (entry.includes(":")) {
      const separator = entry.indexOf(":");
      const kind = entry.slice(0, separator).trim().toLowerCase();
      const id = entry.slice(separator + 1).trim();
      if (kind === chat.kind && id === String(chat.id)) return true;
      continue;
    }
    if (chat.name && entry.toLowerCase() === String(chat.name).toLowerCase()) return true;
  }
  return false;
}

// --- inbound SimpleX -> Paperclip ------------------------------------------

export function extractInboundText(chatItem) {
  if (!chatItem || typeof chatItem !== "object") return null;
  const direction = chatItem.chatDir?.type;
  if (!RECEIVE_DIRECTIONS.has(direction)) return null;
  const content = chatItem.content;
  if (!content || content.type !== "rcvMsgContent") return null;
  const message = content.msgContent;
  if (!message || message.type !== "text" || typeof message.text !== "string") return null;
  return message.text;
}

export function normalizeInboundItem(chat, chatItem) {
  const text = extractInboundText(chatItem);
  if (text === null) return null;
  const itemId = chatItem?.meta?.itemId;
  if (itemId === undefined || itemId === null) return null;
  return {
    chat,
    itemId: String(itemId),
    itemTs: chatItem?.meta?.itemTs ?? chatItem?.meta?.createdAt ?? null,
    direction: chatItem.chatDir.type,
    text,
  };
}

export function selectInboundMessages(event, allowlist) {
  if (!event || event.type !== "newChatItems" || !Array.isArray(event.chatItems)) return [];
  const selected = [];
  for (const aChatItem of event.chatItems) {
    const chat = normalizeChatInfo(aChatItem?.chatInfo);
    if (!chat || !isChatAllowed(chat, allowlist)) continue;
    const item = normalizeInboundItem(chat, aChatItem?.chatItem);
    if (item) selected.push(item);
  }
  return selected;
}

// --- routing ---------------------------------------------------------------

export function isIssueReference(token) {
  return ISSUE_REFERENCE_RE.test(token) || isUuid(token);
}

export function parseRouting(text, prefix = "#") {
  if (typeof text !== "string" || prefix === "") return null;
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length).trimStart();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!match) return null;
  const reference = match[1];
  if (!isIssueReference(reference)) return null;
  return { reference, body: (match[2] ?? "").trim() };
}

// --- sanitization ----------------------------------------------------------

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeText(text, maxBytes = 8000) {
  let cleaned = String(text ?? "").replace(CONTROL_CHARS_RE, "").replace(/\r\n?/g, "\n").trim();
  if (Buffer.byteLength(cleaned, "utf8") <= maxBytes) return cleaned;
  let slice = Buffer.from(cleaned, "utf8").subarray(0, maxBytes).toString("utf8");
  slice = slice.replace(/\uFFFD$/, "");
  return `${slice}\n[truncated]`;
}

export function buildIssueTitle(text, chatName) {
  const firstLine = sanitizeText(text, 8000).split("\n").find((line) => line.trim() !== "");
  if (firstLine && firstLine.trim() !== "") {
    return firstLine.trim().slice(0, 120);
  }
  return chatName ? `Message from ${chatName}` : "Message from SimpleX";
}

// --- idempotency -----------------------------------------------------------

export function deriveIssueIdempotencyKey(chat, itemId) {
  return `simplex-bridge:issue:${chat.key}:${itemId}`;
}

export function deriveCommentClientRequestId(chat, itemId) {
  return uuidv5(`simplex-bridge:comment:${chat.key}:${itemId}`);
}

// --- Paperclip payloads ----------------------------------------------------

export function buildIssuePayload({ chat, text, itemId, projectId, assigneeAgentId, priority }) {
  const body = sanitizeText(text);
  const payload = {
    title: buildIssueTitle(text, chat.name),
    description: buildCommentBody(body, chat),
    projectId,
    idempotencyKey: deriveIssueIdempotencyKey(chat, itemId),
  };
  if (assigneeAgentId) payload.assigneeAgentId = assigneeAgentId;
  if (priority) payload.priority = priority;
  return payload;
}

export function buildCommentBody(text, chat) {
  const name = chat?.name ? `SimpleX chat "${chat.name}"` : "SimpleX";
  return `${text}\n\n_Forwarded from ${name}._`;
}

export function isOwnComment(comment, bridgeAgentId) {
  return Boolean(comment) && comment.authorAgentId === bridgeAgentId;
}

export function normalizeComment(comment) {
  if (!comment || typeof comment !== "object") return null;
  return {
    id: String(comment.id),
    body: typeof comment.body === "string" ? comment.body : "",
    authorAgentId: comment.authorAgentId ?? null,
    createdAt: comment.createdAt ?? null,
  };
}

// --- outbound Paperclip -> SimpleX -----------------------------------------

export function buildSendCommand(chat, text) {
  const ref = `${chat.kind === "group" ? "#" : "@"}${chat.id}`;
  const composed = [{ msgContent: { type: "text", text } }];
  return `/_send ${ref} json ${JSON.stringify(composed)}`;
}
