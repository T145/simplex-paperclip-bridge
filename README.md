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

Direction summary:

- SimpleX to Paperclip: subscribe to core events such as `newChatItem`. For an
  allowlisted sender, either add a comment to an issue named by a routing prefix
  or create a new issue with an idempotency key derived from the message id.
- Paperclip to SimpleX: poll `GET /api/issues/{id}/comments?after={lastCommentId}`
  on a bounded interval and forward each new comment to the matching chat. The
  bridge ignores comments that it authored, to avoid a loop.

## Configuration

All configuration is supplied through environment variables. See `.env.example`
for the placeholder names. Secrets are injected at deploy time and are never
committed.

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
