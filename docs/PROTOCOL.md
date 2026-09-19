# WebSocket protocol (v1)

Endpoint: `ws://<host>:8790/ws?token=<token>` (or `Authorization: Bearer`).
A wrong token closes with 4401. Five failed attempts from one IP within ten
minutes earns a temporary lockout.

## Envelope

Request (client → daemon):
```json
{"id": 12, "type": "chat.send", "data": {...}}
```
Reply:
```json
{"id": 12, "type": "ok", "data": {...}}
{"id": 12, "type": "error", "data": {"message": "..."}}
```
Event (daemon → client, unasked):
```json
{"type": "event", "event": "text.delta", "chat_id": "ab12", "seq": 1042, "data": {...}, "ts": 1757000000.1}
```
`seq` is set on durable events (the ones written to SQLite) and `null` on live
ones. After a reconnect, `chat.get {since_seq}` replays the durable events that
were missed.

## Requests

| type | data | returns |
|---|---|---|
| `hello` | `{device_name?, push_token?}` | `{host, catalog, device}` |
| `host.info` | – | host information |
| `host.models` | – | `{claude: {models, efforts, perm_modes}, codex: {...}}` |
| `host.projects` | – | `{projects: [{path,name,is_git}], roots}` |
| `host.git` | `{paths?}` | `{repos: {<path>: {is_git, branch, dirty, staged, untracked, subject, author, committed_at}}}` — read-only git status, for the desktop panel's project grid. Without `paths`, every allowed project. Runs in a thread pool behind a 20 s cache. `host.projects` does not carry this: the phone's folder picker would have to wait on dozens of git calls every time it opened. |
| `device.prefs` | `{push_approval?, push_done?, push_token?}` | the device's current preferences |
| `device.revoke_self` | – | revokes this device's token |
| `group.list` / `group.create {name}` / `group.rename {group_id,name}` / `group.delete {group_id}` | | |
| `chat.list` | `{include_archived?}` | `{chats, groups}` |
| `chat.create` | `{provider, model?, effort?, perm_mode?, cwd?, group_id?, title?, max_turns?, max_budget_usd?}` | chat |
| `chat.get` | `{chat_id, since_seq?, limit?}` | `{chat, events, pending_approvals, busy}` — `events` are shaped like the envelope's events (`{event, chat_id, seq, data, ts}`) |
| `chat.update` | `{chat_id, ...fields}` | chat (changing model/perm/cwd rebuilds the provider; the resume id survives) |
| `chat.delete` | `{chat_id}` | – |
| `chat.send` | `{chat_id, text, attachments?: [{path}]}` | `{accepted, queued}` — if a turn is running the message is queued (`queued: true`) and runs in order once the turn ends; `chat.interrupt` empties the queue. A full queue (20) returns `error: busy` |
| `chat.interrupt` | `{chat_id}` | – |
| `approval.respond` | `{chat_id, request_id, decision: allow \| allow_session \| deny}` | – |

## Events

| event | durable | data |
|---|---|---|
| `host.status` | – | host information (on connect) |
| `chat.created` / `chat.updated` / `chat.deleted` | – | chat |
| `groups.changed` / `chats.changed` | – | `{groups}` / `{chats}` — the full list, when another device changes a group |
| `message.user` | ✓ | `{text, attachments}` |
| `turn.started` | – | – |
| `text.delta` | – | `{segment, text}` — the same `segment` appends to the same bubble |
| `thinking.delta` | – | `{text}` |
| `message.assistant` | ✓ | `{segment, text, attachments?}` — the segment's final form; replace the live text with this. `attachments` lists the files the text names by local path (see below) |
| `tool.use` | ✓ | `{id, tool, input}` |
| `tool.result` | ✓ | `{id, output, is_error}` |
| `approval.request` | ✓ | `{request_id, tool, input, preview, danger, reason}` |
| `approval.resolved` | ✓ | `{request_id, decision}` |
| `turn.done` | ✓ | `{cost_usd, usage, duration_ms, num_turns, stop_reason}` |
| `turn.error` | ✓ | `{message}` |

Chat `status`: `idle | running | awaiting_approval`.

## The ordering rule (clients)

The timeline is the durable events, in `seq` order. Live `text.delta`s go into a
temporary "streaming segment" bubble; when `message.assistant` arrives, that
segment becomes permanent. A `tool.use` closes the segment before it.

## HTTP: uploads

`POST /upload` (multipart: `file`, `chat_id`), `Authorization: Bearer <token>`.
Returns `{path, name, size}`; `path` is then passed in `chat.send.attachments[]`.
Allowed extensions: png jpg jpeg gif webp heic pdf txt md json csv log · 25 MB.
Files stay under `~/.remote-ai-chat/uploads/<chat_id>/`.

## HTTP: files, both directions

`GET /files?path=<abs>&token=<token>[&download=1]` serves a file to a client.
Two kinds qualify: anything under the uploads folder (the phone sent it), and
anything the path policy allows — inside an allowed root, outside every denied
path, not a secret (`.env*`, keys, `.git/`, `.ssh/`, …). `download=1` sets a
`Content-Disposition: attachment` so a browser saves instead of showing.

The agent has no upload button. To show a file it writes the path into its
message as Markdown — `![caption](/abs/path.png)` or `[name](/abs/path.pdf)` —
and the daemon lifts every such path that the policy would serve into
`message.assistant.attachments[]`, each `{path, name, size, kind, url}` with the
same shape as an upload. The text is left as written. A client shows images
inline and the rest as an openable chip; a client that does not know about
attachments still shows a readable path. At most 12 per message.

A picture also carries `view`: a copy of it kept under the uploads folder, which
`/files` serves whatever happens to the original. Draw a bubble from `view` when
it is there and fall back to `path`; `path` is still what the message says, what
a download opens, and what the text is matched against. Without this a chat
scrolled back to shows a file name where a screenshot was, because the agent
cleaned up after itself.

## Codex mapping

| perm_mode | approvalPolicy | sandbox |
|---|---|---|
| suggest | untrusted | read-only |
| auto-edit | on-request | workspace-write |
| full-auto | on-failure | workspace-write |
| bypass | untrusted (the daemon auto-approves anything not flagged dangerous) | danger-full-access |

## Accounts and tools

| type | data | returns |
|---|---|---|
| `account.list` | – | `{accounts: [{id, provider, label, logged_in, detail, is_default}]}` |
| `account.create` | `{provider, label}` | account |
| `account.login` | `{account_id}` | `{started, provider, needs_code}` — the prompt goes **only to the asking socket** |
| `account.login.submit` | `{account_id, code}` | – (Claude only) |
| `account.login.cancel` | `{account_id}` | – |
| `account.logout` | `{account_id}` | account |
| `account.delete` | `{account_id}` | – (chats bound to it are released) |
| `account.export` | `{account_id}` | `{provider, label, detail, credentials}` — the stored sign-in |
| `account.import` | `{account_id, credentials}` | account + `{verified, verify_error}` |
| `account.forget` | `{account_id}` | account — deletes the sign-in **locally only** |
| `tool.status` | – | `{tools: [{provider, version, path}], npm}` |
| `tool.install` | `{provider, force?}` | `{provider, version, path}` — output streams |

### Moving a sign-in to another computer

When the browser flow cannot be finished from the phone, a sign-in can be moved
off a computer that already has one. **It is a move, not a copy:** both CLIs use
single-use refresh tokens — whichever machine refreshes first gets the new
token and the other copy dies (Codex says so outright: `your refresh token was
already used`). So the order is:

1. The phone calls `account.export` on the source computer, over a separate
   socket.
2. `account.import` on the target writes the file with mode 0600 and then makes
   the CLI issue **a real request**. `auth status` only reads the local file and
   will call a revoked token "signed in"; `verified` is what tells them apart.
3. If verification passes, the phone calls `account.forget` on the source. That
   does not make the CLI log out: a real logout would revoke the token the
   target is now using.

`account.import` refuses to write into the computer's own (built-in) account: on
macOS that sign-in is read from the keychain, and the `imported` flag is not
kept for the built-in account.

Events: `account.login.prompt {account_id, provider, url, url_host, code, needs_code, expires_at}`,
`account.login.done {account_id, ok, detail, error, retryable}`, `tool.install.output {provider, line}`.
Those three are **not durable** and go only to the device that asked.

Chat-to-account rules: an empty `chats.account_id` means the computer's own
account. If the account was removed the turn is refused rather than quietly
falling back to the default. Changing account resets `provider_session_id`,
because the transcript store belongs to one account's folder.
