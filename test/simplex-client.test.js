import { test } from "node:test";
import assert from "node:assert/strict";

import { SimplexClient } from "../src/simplex-client.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  message(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function makeClient(overrides = {}) {
  const sockets = [];
  const client = new SimplexClient({
    url: "ws://127.0.0.1:5225",
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    random: () => 1,
    ...overrides,
  });
  return { client, sockets };
}

test("start resolves once the socket opens", async () => {
  const { client, sockets } = makeClient();
  const started = client.start();
  sockets[0].open();
  await started;
  assert.equal(client.isConnected(), true);
  await client.stop();
});

test("sendCommand correlates the response by corrId", async () => {
  const { client, sockets } = makeClient();
  const started = client.start();
  sockets[0].open();
  await started;

  const pending = client.sendCommand("/_send @7 json []");
  await flush();
  const frame = JSON.parse(sockets[0].sent[0]);
  assert.equal(frame.cmd, "/_send @7 json []");
  assert.ok(frame.corrId);

  sockets[0].message({ corrId: frame.corrId, resp: { type: "newChatItems", chatItems: [] } });
  const resp = await pending;
  assert.equal(resp.type, "newChatItems");
  await client.stop();
});

test("events without a corrId are dispatched to handlers", async () => {
  const { client, sockets } = makeClient();
  const started = client.start();
  sockets[0].open();
  await started;

  const events = [];
  client.onEvent((event) => events.push(event));
  sockets[0].message({ resp: { type: "newChatItems", chatItems: [{ ok: true }] } });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "newChatItems");
  await client.stop();
});

test("sendCommand times out when no response arrives", async () => {
  const { client, sockets } = makeClient({ timeoutMs: 20 });
  const started = client.start();
  sockets[0].open();
  await started;
  await assert.rejects(() => client.sendCommand("/_send @7 json []"), /timed out/);
  await client.stop();
});

test("a dropped socket rejects pending commands and schedules a reconnect", async () => {
  const scheduled = [];
  const { client, sockets } = makeClient({
    setTimeoutFn: (fn, ms) => {
      scheduled.push({ fn, ms });
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });
  const started = client.start();
  sockets[0].open();
  await started;

  const pending = client.sendCommand("/_send @7 json []");
  await flush();
  sockets[0].close();
  await assert.rejects(() => pending, /closed/);
  assert.equal(client.isConnected(), false);
  assert.ok(
    scheduled.some((entry) => entry.ms === 10),
    "a reconnect was scheduled with the base backoff delay"
  );

  await client.stop();
  assert.equal(client.stopped, true);
});

test("stop closes the socket", async () => {
  const { client, sockets } = makeClient();
  const started = client.start();
  sockets[0].open();
  await started;
  await client.stop();
  assert.equal(sockets[0].closed, true);
  assert.equal(client.isConnected(), false);
});
