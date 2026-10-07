// A tiny dependency-free WebSocket server that speaks enough of the SimpleX
// core protocol for local testing and for the local-run harness.
//
// It performs the RFC 6455 handshake, parses masked client text frames, records
// each command it receives, answers commands with a `resp` frame carrying the
// same `corrId`, and can push events to every connected client.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function createMockCore({ port = 5225, host = "127.0.0.1", logger = null } = {}) {
  const clients = new Set();
  const commands = [];

  const server = createServer((request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required\n");
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );
    const client = { socket, buffer: Buffer.alloc(0), fragments: [] };
    clients.add(client);
    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const { frames, rest } = parseFrames(client.buffer);
      client.buffer = rest;
      for (const frame of frames) handleFrame(client, frame);
    });
    const drop = () => clients.delete(client);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  function handleFrame(client, frame) {
    if (frame.opcode === 0x8) {
      client.socket.end();
      clients.delete(client);
      return;
    }
    if (frame.opcode === 0x9) {
      client.socket.write(encodeFrame(frame.payload, 0x0a));
      return;
    }
    if (frame.opcode === 0x0) {
      client.fragments.push(frame.payload);
      if (!frame.fin) return;
      const payload = Buffer.concat(client.fragments);
      client.fragments = [];
      handleText(client, payload.toString("utf8"));
      return;
    }
    if (frame.opcode === 0x1) {
      if (!frame.fin) {
        client.fragments = [frame.payload];
        return;
      }
      handleText(client, frame.payload.toString("utf8"));
    }
  }

  function handleText(client, text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      logger?.warn?.("mock core received non-JSON frame", error.message);
      return;
    }
    const corrId = parsed.corrId;
    const cmd = parsed.cmd;
    commands.push({ corrId, cmd });
    logger?.info?.(`mock core received command: ${cmd}`);
    const resp = String(cmd).startsWith("/_send")
      ? { type: "newChatItems", user: { userId: 1 }, chatItems: [] }
      : { type: "chatCmdError", chatError: { type: "CMD", cmdErr: "unknown command" } };
    send(client, { corrId, resp });
  }

  function send(client, frame) {
    client.socket.write(encodeFrame(Buffer.from(JSON.stringify(frame), "utf8")));
  }

  function emitEvent(resp) {
    const frame = encodeFrame(Buffer.from(JSON.stringify({ resp }), "utf8"));
    for (const client of clients) client.socket.write(frame);
  }

  return {
    commands,
    emitEvent,
    get connectionCount() {
      return clients.size;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of clients) {
          try {
            client.socket.end();
          } catch {
            // ignore
          }
        }
        clients.clear();
        server.close(() => resolve());
      });
    },
  };
}

function encodeFrame(payload, opcode = 0x1) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - offset < headerLength + 4) break;
      maskKey = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      headerLength += 4;
    }
    if (buffer.length - offset < headerLength + length) break;
    let payload = buffer.subarray(offset + headerLength, offset + headerLength + length);
    if (masked) {
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    frames.push({ fin, opcode, payload });
    offset += headerLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
