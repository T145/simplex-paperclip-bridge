// Bridge orchestration.
//
// Two directions:
//   SimpleX -> Paperclip: consume newChatItems events, map allowlisted text
//   messages onto comments or new issues with idempotency keys.
//   Paperclip -> SimpleX: poll tracked issues for new comments and forward each
//   one to the matching chat, skipping comments the bridge itself authored.

import {
  selectInboundMessages,
  parseRouting,
  sanitizeText,
  buildCommentBody,
  buildIssuePayload,
  deriveCommentClientRequestId,
  isOwnComment,
  buildSendCommand,
} from "./mapping.js";

export class Bridge {
  constructor({
    config,
    logger,
    paperclip,
    simplex,
    state,
    now = () => new Date().toISOString(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.config = config;
    this.logger = logger;
    this.paperclip = paperclip;
    this.simplex = simplex;
    this.state = state;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.pollTimer = null;
    this.polling = false;
    this.started = false;
    this.eventQueue = Promise.resolve();
  }

  async start() {
    await this.state.load();
    this.unsubscribe = this.simplex.onEvent((event) => this._enqueueEvent(event));
    await this.simplex.start();
    this.started = true;
    this._schedulePoll();
    this.logger?.info(
      `bridge started; polling every ${this.config.pollIntervalMs}ms for ${this.state.listChats().length} tracked chat(s)`
    );
  }

  async stop() {
    this.started = false;
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribe?.();
    await this.simplex.stop();
    await this.state.save();
    this.logger?.info("bridge stopped");
  }

  _schedulePoll() {
    if (this.pollTimer) return;
    this.pollTimer = this.setIntervalFn(() => {
      this.pollOnce().catch((error) => this.logger?.error("poll failed", error.message));
    }, this.config.pollIntervalMs);
    if (typeof this.pollTimer?.unref === "function") this.pollTimer.unref();
  }

  _enqueueEvent(event) {
    this.eventQueue = this.eventQueue
      .then(() => this.handleEvent(event))
      .catch((error) => this.logger?.error("event handling failed", error.message));
    return this.eventQueue;
  }

  async handleEvent(event) {
    const messages = selectInboundMessages(event, this.config.allowlist);
    if (messages.length === 0) return [];
    const results = [];
    for (const message of messages) {
      try {
        results.push(await this.handleInbound(message));
      } catch (error) {
        this.logger?.error(
          `failed to forward message ${message.chat.key}:${message.itemId}: ${error.message}`
        );
        results.push({ status: "error", itemId: message.itemId, error: error.message });
      }
    }
    return results;
  }

  async handleInbound(message) {
    const { chat, itemId, text } = message;
    const inboundKey = `${chat.key}:${itemId}`;
    if (this.state.hasProcessedInbound(inboundKey)) {
      return { status: "duplicate", itemId };
    }

    const routing = parseRouting(text, this.config.issueReferencePrefix);
    if (routing) {
      const body = sanitizeText(routing.body === "" ? "(empty message)" : routing.body, this.config.maxMessageBytes);
      const clientRequestId = deriveCommentClientRequestId(chat, itemId);
      const comment = await this.paperclip.addComment(routing.reference, {
        body: buildCommentBody(body, chat),
        clientRequestId,
      });
      await this.state.upsertChat(chat.key, {
        kind: chat.kind,
        id: chat.id,
        name: chat.name,
        issueIdentifier: routing.reference,
        lastCommentId: comment?.id ?? null,
      });
      await this.state.recordInbound(inboundKey);
      this.logger?.info(`commented on ${routing.reference} from ${chat.key}:${itemId}`);
      return { status: "commented", reference: routing.reference, itemId };
    }

    const payload = buildIssuePayload({
      chat,
      text,
      itemId,
      projectId: this.config.paperclipProjectId,
      assigneeAgentId: this.config.defaultAssigneeAgentId,
      priority: this.config.defaultPriority,
    });
    const issue = await this.paperclip.createIssue(payload);
    await this.state.upsertChat(chat.key, {
      kind: chat.kind,
      id: chat.id,
      name: chat.name,
      issueId: issue?.id ?? null,
      issueIdentifier: issue?.identifier ?? null,
      lastCommentId: null,
    });
    await this.state.recordInbound(inboundKey);
    this.logger?.info(`created issue ${issue?.identifier ?? issue?.id} from ${chat.key}:${itemId}`);
    return { status: "created", issueId: issue?.id, identifier: issue?.identifier, itemId };
  }

  async pollOnce() {
    if (this.polling) return [];
    this.polling = true;
    try {
      const results = [];
      for (const chat of this.state.listChats()) {
        try {
          results.push(await this.pollChat(chat));
        } catch (error) {
          this.logger?.error(`poll failed for ${chat.key}: ${error.message}`);
          results.push({ chat: chat.key, error: error.message });
        }
      }
      return results;
    } finally {
      this.polling = false;
    }
  }

  async pollChat(chat) {
    const issueRef = chat.issueIdentifier ?? chat.issueId;
    if (!issueRef) return { chat: chat.key, forwarded: 0 };
    const comments = await this.paperclip.listComments(issueRef, { after: chat.lastCommentId ?? undefined });
    let forwarded = 0;
    for (const comment of comments) {
      if (comment.id === chat.lastCommentId) continue;
      if (this.state.hasProcessedComment(chat.key, comment.id)) continue;
      if (!isOwnComment(comment, this.config.bridgeAgentId)) {
        const text = sanitizeText(comment.body, this.config.maxMessageBytes);
        const response = await this.simplex.sendCommand(buildSendCommand(chat, text));
        if (response && response.type === "chatCmdError") {
          throw new Error(`simplex send rejected: ${JSON.stringify(response.chatError ?? {})}`);
        }
        forwarded += 1;
        this.logger?.info(`forwarded comment ${comment.id} to ${chat.key}`);
      }
      await this.state.setLastCommentId(chat.key, comment.id);
    }
    return { chat: chat.key, forwarded };
  }
}
