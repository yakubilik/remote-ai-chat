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
| `chat.create` | `{provider, model?, effort?, perm_mode?, cwd?, group_id?, title?, max_turns?, max_budget_usd?, pool_pinned?}` | chat |
| `chat.get` | `{chat_id, since_seq?, limit?}` | `{chat, events, pending_approvals, busy}` — `events` are shaped like the envelope's events (`{event, chat_id, seq, data, ts}`) |
| `chat.update` | `{chat_id, ...fields}` | chat (changing model/perm/cwd rebuilds the provider; the resume id survives) |
| `chat.delete` | `{chat_id}` | – |
| `chat.send` | `{chat_id, text, attachments?: [{path}]}` | `{accepted, queued}` — if a turn is running the message is queued (`queued: true`) and runs in order once the turn ends; `chat.interrupt` empties the queue. A full queue (20) returns `error: busy` |
| `chat.interrupt` | `{chat_id}` | – |
| `approval.respond` | `{chat_id, request_id, decision: allow \| allow_session \| deny}` | – |
| `limits.get` | – | `{accounts: {<account_id>: [window, …]}}` — the last word on every plan, as the tool reported it |
| `pool.get` | `{provider?}` | `{settings, accounts}` — see *The account pool* |
| `pool.set` | any of `{enabled, threshold, thresholds, use_overage, overage_by_account, reserve, order, max_hops}` | `{settings, accounts}` — only the keys sent are changed |

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
| `limits` | – | `{window, status, utilization, resets_at, overage_status, overage_resets_at, overage_disabled_reason, is_using_overage, windows: [...]}` — what is left of the plan. Only Claude sends it, only while a turn is running, and the account it describes is the one that chat is on. `windows` is every window; the fields beside it describe only the one the tool singled out |
| `account.switched` | ✓ | `{from, to, reason, provider}` — the pool moved this chat to another sign-in |
| `pool.exhausted` | ✓ | `{account_id, window, until}` — the plan is spent and there was nowhere to move to |
| `pool.updated` | – | `{settings, accounts}` — someone changed the pool from another device |

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

## The account pool

Several sign-ins of one tool, driven as one. Off by default; `pool.set
{enabled: true}` turns it on. It is a mode, not a per-chat setting: with it on
every chat moves, and `chats.pool_pinned = 1` is the way out for a chat that has
to stay on one sign-in.

`pool.get` answers with both halves:

```
settings  {enabled, threshold, thresholds: {<window>: 0..1}, use_overage: "account" | "never", overage_by_account: {<account_id>: "account" | "never"}, reserve, order: {<provider>: [account_id, …]}, max_hops}
accounts  [{account_id, provider, label, blocked, window, until, utilization, on_overage, spending, step, margin, strict, unknown}, …]
```

`accounts` comes back in the order the pool tries them, which is `order` first
and then everything not named in it. An account is `blocked` when one of its
windows is at or past that window's line and has not reset since it was
measured. The line is per window — `thresholds` names the ones that differ,
`threshold` covers the rest — because the windows are not alike: `five_hour` is
held at 0.95 by default, since it refills several times a day and stopping
early there costs a couple of hours, while the weeklies sit at 0.99, where the
same 5% would be most of a working day. Pay-as-you-go rescues it — a sign-in that can spend past its plan
is reported `on_overage`, not blocked — unless `use_overage` is `"never"`. An
account nobody has run is `unknown`: it is tried, not assumed full.

`"never"` is the setting with money behind it, and it is decided **per sign-in**:
`overage_by_account` overrides `use_overage` for one account, so one can spend
past its plan while another never touches it. A sign-in under it reports
`strict: true`.

There is no flag that makes the CLI refuse overage — extra usage is an
account-level setting on Anthropic's side — so when an account *can* bill past
its plan and the user has said not to, the daemon is the only guard. Three
things make it one:

* `spending` (the tool's own `isUsingOverage`, read together with
  `overage_status`, as the CLI's own note says to) blocks the account on its
  own. It means paid usage is covering sends *now*, and no window reading makes
  that acceptable.
* A **margin**, sized by how coarsely this account actually reports. Readings
  arrive in jumps; the daemon records the widest jump one window has made
  between two consecutive readings (`step`) and holds that much back below the
  threshold (`margin`). Within one step of the line counts as over it. Until a
  step has been measured, `reserve` stands in for one (10% by default), and the
  measured one takes over when it is wider. This is the part that does not
  depend on a report arriving at the right moment — it bounds the only thing
  the daemon cannot see, which is what happens between two reports. The price
  is one step's worth of every window left unused.
* The interrupt comes before anything else. Choosing the next sign-in means
  asking the CLI whether it is still signed in, which is a subprocess; the
  running turn is stopped first and the session resolves where it goes after.

The same question is asked the same way whether a turn is about to open on an
account or is already running there. Being gentler on the running turn would
mean letting it continue into exactly the reading a new turn was not allowed to
start into.

None of this is load-bearing when extra usage is switched off on the account
itself: the platform refuses rather than bills, so a late move costs a dead turn
and not a cent (`overage_status: rejected` with an `overage_disabled_reason`).

A chat is moved at two moments:

* **before a turn opens**, which is free — nothing has been connected yet; and
* **while one is running**, on the `limits` report that crosses the threshold.
  The turn is interrupted, the chat is rebound, and the next sign-in is handed
  the chat's own transcript (the same recap a dropped session gets) plus a note
  saying it has walked into a turn already under way. Same model, same effort;
  a different context, so the move costs whatever the recap could not carry.
  Nothing queued behind the turn is lost.

Either way the chat's timeline gets a durable `account.switched`. The move
clears `provider_session_id`, as any account change does. When every sign-in is
spent the turn stops where it was interrupted, anything queued behind it is
dropped, and `pool.exhausted` says so on the timeline. Resuming on the spent
account would either be refused or — on a sign-in that bills past its plan — be
exactly the spending the pool was turned on to prevent.

Only Claude reports plan windows, so only Claude can be moved before it hits a
limit; a Codex chat in the pool is never handed over.

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
