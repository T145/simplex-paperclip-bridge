# simplex-paperclip-bridge

A self hosted bridge between a [SimpleX Chat](https://simplex.chat) core and a
Paperclip control plane. It moves chat messages into Paperclip issues and posts
Paperclip comments back into the matching SimpleX conversation.

This repository is intentionally generic. It contains no secrets, no private
hostnames, no internal issue identifiers, and no customer or production data.

## How it works

The bridge runs as a small long lived service next to a `simplex-chat` core that
is started in server mode:

```
simplex-chat --chat-server-port 5225
```

It connects to the core over the local WebSocket API at
`ws://127.0.0.1:5225` and, in the other direction, polls the Paperclip public API
for new comments on the issues it tracks. Polling is used deliberately so the
bridge does not need to expose an inbound HTTP endpoint.

The bridge has no runtime dependencies. It uses the built in WebSocket client
and the built in fetch in Node 22 and newer.

### SimpleX to Paperclip

The bridge subscribes to `newChatItems` events and processes received text
messages from allowlisted chats only. Each message maps to one of two actions:

- A message that starts with the routing prefix (`#` by default) followed by an
  issue identifier or a UUID adds a comment to that issue. For example,
  `#API-1001 on my way` comments on the issue with that identifier.
- Any other message creates a new issue in the configured project. The issue is
  assigned through the optional routing variables if they are set.

Issue creation uses an idempotency key derived from the SimpleX message id, so a
retry after a network error does not create a duplicate issue. Comment creation
uses a deterministic client request id for the same reason.

### Paperclip to SimpleX

The bridge polls each tracked issue with
`GET /api/issues/{id}/comments?after={lastCommentId}` on a bounded interval and
forwards every new comment to the matching chat. Comments the bridge itself
authored are skipped, which prevents a loop between the two directions. The last
processed comment id is stored so a restart does not replay old comments.

### Safety

- A strict allowlist of chats gates the SimpleX to Paperclip direction. Messages
  from unknown senders are ignored.
- Message bodies are size limited and stripped of control characters before they
  reach either API.
- Attachments are out of scope for this version.
- The bridge posts as one dedicated identity that is not the assignee of the
  issues it writes to, so a bridge comment still wakes the assignee.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/config.js` | Reads and validates environment variables. |
| `src/logger.js` | Small leveled logger. |
| `src/retry.js` | Exponential backoff with equal jitter. |
| `src/uuid.js` | Deterministic UUIDs for comment idempotency. |
| `src/mapping.js` | Pure message mapping and sanitization. |
| `src/state-store.js` | Durable, atomically written local state. |
| `src/simplex-client.js` | WebSocket client with command correlation and reconnect. |
| `src/paperclip-client.js` | Paperclip public API client with retry. |
| `src/bridge.js` | Orchestrates both directions. |
| `src/index.js` | Entry point and signal handling. |

## Configuration

All configuration is supplied through environment variables. See `.env.example`
for the placeholder names. Secrets are injected at deploy time and are never
committed.

## Running

```
cp .env.example .env
# edit .env
node src/index.js
```

## Testing

The test suite uses the built in Node test runner and needs no installed
dependencies:

```
npm test
```

`npm run local-run` starts a mock SimpleX core and a mock Paperclip API, runs the
real bridge against them, and proves both directions plus idempotency. It prints
`local run: PASS` on success.

## Anonymity scan

`scripts/anonymity-scan.sh` checks the working tree and the full git history for
information that must not appear in a public repository: a supplied deny-list of
names, email addresses, IP addresses, internal hostnames, secret-like strings,
and issue identifiers.

The deny-list is provided out of band through the `ANON_DENYLIST` environment
variable as a comma separated list. It is never stored in this repository.

```sh
ANON_DENYLIST="name-one,name-two" scripts/anonymity-scan.sh
```

Run the scan before every push. The same scan runs in CI.

## License

This project is licensed under the GNU Affero General Public License, version 3.
See `LICENSE`. SimpleX Chat is licensed separately; see `NOTICE` for
attribution.
