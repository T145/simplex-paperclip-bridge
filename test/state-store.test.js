import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StateStore } from "../src/state-store.js";

async function tempStatePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "simplex-bridge-state-"));
  return { dir, file: path.join(dir, "state.json") };
}

test("load returns empty state when the file does not exist", async () => {
  const { dir, file } = await tempStatePath();
  try {
    const store = new StateStore(file);
    const state = await store.load();
    assert.deepEqual(state.chats, {});
    assert.deepEqual(state.processedInbound, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordInbound persists, deduplicates, and survives reload", async () => {
  const { dir, file } = await tempStatePath();
  try {
    const store = new StateStore(file);
    await store.load();
    await store.recordInbound("direct:7:1");
    await store.recordInbound("direct:7:1");
    await store.recordInbound("direct:7:2");
    assert.equal(store.hasProcessedInbound("direct:7:1"), true);
    assert.equal(store.hasProcessedInbound("direct:7:3"), false);

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(raw.processedInbound, ["direct:7:1", "direct:7:2"]);

    const reloaded = new StateStore(file);
    await reloaded.load();
    assert.equal(reloaded.hasProcessedInbound("direct:7:2"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processed inbound history is bounded", async () => {
  const { dir, file } = await tempStatePath();
  try {
    const store = new StateStore(file, { historyLimit: 100 });
    await store.load();
    for (let i = 0; i < 150; i += 1) await store.recordInbound(`k${i}`);
    assert.equal(store.state.processedInbound.length, 100);
    assert.equal(store.hasProcessedInbound("k0"), false);
    assert.equal(store.hasProcessedInbound("k149"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat mappings can be upserted and listed", async () => {
  const { dir, file } = await tempStatePath();
  try {
    const store = new StateStore(file);
    await store.load();
    await store.upsertChat("direct:7", { kind: "direct", id: "7", issueId: "abc" });
    await store.upsertChat("direct:7", { issueIdentifier: "API-1001" });
    const chat = store.getChat("direct:7");
    assert.equal(chat.issueId, "abc");
    assert.equal(chat.issueIdentifier, "API-1001");
    assert.equal(store.listChats().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("comment progress is tracked per chat", async () => {
  const { dir, file } = await tempStatePath();
  try {
    const store = new StateStore(file);
    await store.load();
    await store.upsertChat("direct:7", { issueIdentifier: "API-1001" });
    await store.setLastCommentId("direct:7", "c1");
    await store.setLastCommentId("direct:7", "c2");
    assert.equal(store.getChat("direct:7").lastCommentId, "c2");
    assert.equal(store.hasProcessedComment("direct:7", "c1"), true);
    assert.equal(store.hasProcessedComment("direct:7", "c2"), true);
    assert.equal(store.hasProcessedComment("direct:7", "c3"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load rejects a corrupt or wrong-version state file", async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeFile(file, "{ not json", "utf8");
    await assert.rejects(() => new StateStore(file).load(), /not valid JSON/);

    await writeFile(file, JSON.stringify({ version: 999 }), "utf8");
    await assert.rejects(() => new StateStore(file).load(), /unsupported version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
