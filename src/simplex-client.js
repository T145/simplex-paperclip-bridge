// SimpleX Chat core WebSocket client.
//
// Protocol reference: the core exposes a local WebSocket that accepts command
// frames `{ corrId, cmd }` and emits responses and events as frames containing
// a `resp` object with a `type` tag. Events carry no `corrId`; command
// responses echo the `corrId` sent with the command.
//
// The client correlates command responses, dispatches events, and reconnects
// with exponential backoff when the socket drops.

import { backoffDelay } from "./retry.js";

function defaultWebSocketFactory(url) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("global WebSocket is not available; Node 22 or newer is required");
  }
  return new globalThis.WebSocket(url);
}

export class SimplexClient {
  constructor({
    url,
    timeoutMs = 15000,
    logger = null,
    webSocketFactory = defaultWebSocketFactory,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 30000,
    random = Math.random,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.webSocketFactory = webSocketFactory;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.random = random;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;

    this.socket = null;
    this.connected = false;
    this.stopped = false;
    this.counter = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.reconnectAttempt = 0;
    this._openWaiters = [];
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isConnected() {
    return this.connected;
  }

  start() {
    this.stopped = false;
    return this._connect();
  }

  async _connect() {
    if (this.socket) return this._waitForOpen();
    const socket = this.webSocketFactory(this.url);
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let settled = false;
      socket.onopen = () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.logger?.info("simplex socket open");
        this._flushOpenWaiters();
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      socket.onmessage = (event) => this._handleMessage(event?.data);
      socket.onerror = (error) => {
        this.logger?.warn("simplex socket error", error?.message ?? error ?? "");
      };
      socket.onclose = () => {
        this.connected = false;
        this.socket = null;
        this._rejectPending(new Error("simplex socket closed"));
        this.logger?.warn("simplex socket closed");
        if (!settled) {
          settled = true;
          reject(new Error("simplex socket closed before open"));
        }
        this._scheduleReconnect();
      };
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = backoffDelay(this.reconnectAttempt, {
      baseMs: this.reconnectBaseMs,
      maxMs: this.reconnectMaxMs,
      random: this.random,
    });
    this.reconnectAttempt += 1;
    this.logger?.info(`reconnecting to simplex core in ${delay}ms`);
    this.setTimeoutFn(() => {
      if (this.stopped) return;
      this._connect().catch((error) => this.logger?.warn("reconnect failed", error.message));
    }, delay);
  }

  _flushOpenWaiters() {
    const waiters = this._openWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _waitForOpen() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => this._openWaiters.push(resolve));
  }

  _handleMessage(data) {
    if (typeof data !== "string") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      this.logger?.warn("ignoring non-JSON frame", error.message);
      return;
    }
    if (parsed && typeof parsed.corrId === "string" && this.pending.has(parsed.corrId)) {
      const entry = this.pending.get(parsed.corrId);
      this.pending.delete(parsed.corrId);
      this.clearTimeoutFn(entry.timer);
      entry.resolve(parsed.resp);
      return;
    }
    if (parsed && parsed.resp && typeof parsed.resp.type === "string") {
      for (const handler of this.handlers) {
        try {
          handler(parsed.resp);
        } catch (error) {
          this.logger?.error("event handler failed", error.message);
        }
      }
    }
  }

  _rejectPending(error) {
    for (const [, entry] of this.pending) {
      this.clearTimeoutFn(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async sendCommand(command) {
    await this._waitForOpen();
    const socket = this.socket;
    if (!socket) throw new Error("simplex socket is not connected");
    const corrId = `bridge-${++this.counter}`;
    const frame = JSON.stringify({ corrId, cmd: command });
    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        if (this.pending.delete(corrId)) {
          reject(new Error(`command timed out after ${this.timeoutMs}ms: ${command}`));
        }
      }, this.timeoutMs);
      this.pending.set(corrId, { resolve, reject, timer });
      try {
        socket.send(frame);
      } catch (error) {
        this.pending.delete(corrId);
        this.clearTimeoutFn(timer);
        reject(error);
      }
    });
  }

  async stop() {
    this.stopped = true;
    this._rejectPending(new Error("client stopped"));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.connected = false;
  }
}
