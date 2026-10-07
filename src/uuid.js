// Deterministic UUID generation.
//
// The Paperclip comment endpoint accepts a `clientRequestId` UUID for
// idempotency. We derive it deterministically from the SimpleX message id so a
// retry after a network error reuses the same id instead of creating a second
// comment.

import { createHash } from "node:crypto";

// Fixed namespace for all ids this bridge derives. Arbitrary but stable.
export const BRIDGE_NAMESPACE = "f1b4b6c2-7e3a-4c9d-9a1e-2b6f0d5c8a71";

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function uuidv5(name, namespace = BRIDGE_NAMESPACE) {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(String(name), "utf8");
  const hash = createHash("sha1").update(nsBytes).update(nameBytes).digest();
  const bytes = new Uint8Array(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}
