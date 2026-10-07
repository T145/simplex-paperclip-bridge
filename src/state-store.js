// Durable local state.
//
// The bridge records which SimpleX messages it has already handled and, for
// each tracked chat, the Paperclip issue it maps to and the last comment it
// forwarded. State is written atomically so a crash cannot leave a truncated
// file.

import { promises as defaultFs } from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, chats: {}, processedInbound: [] };
}

export class StateStore {
  constructor(filePath, { historyLimit = 2000, fs = defaultFs, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.historyLimit = historyLimit;
    this.fs = fs;
    this.now = now;
    this.state = emptyState();
    this._inbound = new Set();
  }

  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.state = emptyState();
        this._inbound = new Set();
        return this.state;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`state file ${this.filePath} is not valid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) {
      throw new Error(`state file ${this.filePath} has an unsupported version`);
    }
    this.state = {
      version: STATE_VERSION,
      chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
      processedInbound: Array.isArray(parsed.processedInbound) ? parsed.processedInbound : [],
    };
    this._inbound = new Set(this.state.processedInbound);
    return this.state;
  }

  async save() {
    const directory = path.dirname(this.filePath);
    await this.fs.mkdir(directory, { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    await this.fs.writeFile(temp, body, "utf8");
    await this.fs.rename(temp, this.filePath);
  }

  hasProcessedInbound(key) {
    return this._inbound.has(key);
  }

  async recordInbound(key) {
    if (this._inbound.has(key)) return;
    this._inbound.add(key);
    this.state.processedInbound.push(key);
    const overflow = this.state.processedInbound.length - this.historyLimit;
    if (overflow > 0) {
      const dropped = this.state.processedInbound.splice(0, overflow);
      for (const droppedKey of dropped) this._inbound.delete(droppedKey);
    }
    await this.save();
  }

  getChat(key) {
    const value = this.state.chats[key];
    return value ? { key, ...value } : null;
  }

  listChats() {
    return Object.entries(this.state.chats).map(([key, value]) => ({ key, ...value }));
  }

  async upsertChat(key, patch) {
    const existing = this.state.chats[key] ?? {};
    this.state.chats[key] = { ...existing, ...patch, updatedAt: this.now() };
    await this.save();
    return this.state.chats[key];
  }

  async setLastCommentId(key, commentId) {
    const chat = this.state.chats[key];
    if (!chat) return;
    chat.lastCommentId = commentId;
    chat.recentCommentIds = Array.isArray(chat.recentCommentIds) ? chat.recentCommentIds : [];
    if (!chat.recentCommentIds.includes(commentId)) chat.recentCommentIds.push(commentId);
    if (chat.recentCommentIds.length > 50) {
      chat.recentCommentIds.splice(0, chat.recentCommentIds.length - 50);
    }
    chat.updatedAt = this.now();
    await this.save();
  }

  hasProcessedComment(key, commentId) {
    const chat = this.state.chats[key];
    if (!chat) return false;
    return chat.lastCommentId === commentId || (chat.recentCommentIds ?? []).includes(commentId);
  }
}
