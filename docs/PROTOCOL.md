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
| `call.hello` | – | `{working, blocked, idle}` — sent as the phone opens the call screen; no model, instant. Warms the session in the background |
| `call.ask` | `{text, reset?}` | `{text, ms, connect_ms, first_token_ms, cost_usd, snapshot_chars, turn}` — the concierge (see below). `reset` starts the session over |
| `call.digest` | – | `{digest}` — the snapshot the concierge sees, before the model touches it |

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
| `message.assistant` | ✓ | `{segment, text}` — the segment's final form; replace the live text with this |
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

## The concierge (`call.ask`)

"What is it doing" should not wait on a chat turn. When the question arrives the
daemon builds a compact **snapshot** out of SQLite — running sessions, the
current tool, how many minutes the turn has been going, pending approvals, the
last sentence said — and hands that to a tool-less, kept-warm Haiku session. The
answer is one sentence, written to be read aloud.

Measured (`scripts/call_bench.py`, snapshot ≈ 1500 characters):

| | median | worst |
|---|---|---|
| first question (including CLI startup) | ~5 s | – |
| every question after | **~1.2–1.5 s** | ~1.9 s |

Three decisions hold that number, and all three were measured rather than
guessed:

* **`thinking: disabled`.** Haiku's thinking costs ~1.6 s a turn and buys
  nothing here — the state is already in the snapshot, there is nothing to
  reason about. Median 2.9 s → 1.2 s, with byte-identical answers.
* **`tools=[]`.** The concierge cannot read a file, run a command or search for
  anything. That is the reason for both the speed and the safety: nothing
  outside the snapshot can be produced, so "I don't know" is what is left.
* **A warm session.** The client stays connected between questions, so "and the
  other one?" is free. It resets after 24 questions or 10 minutes of silence —
  every question resends the snapshot, so a long call would otherwise be
  carrying fifty stale copies of the state.

`call.digest` takes the model out of the loop. A bad answer is almost always the
snapshot's fault rather than the model's, and this is how you find out which.

### Answering the phone

A real phone says something before you do, and says it immediately. The
concierge's first answer used to take ~3.9 s cold, because the CLI sets itself
up **on the first query**.

So the two were separated:

* **"Hello?" is the phone's own voice.** No network at all, the instant the
  button is pressed.
* **`call.hello`** comes back in milliseconds with three numbers (running /
  waiting / idle) — one SQLite read, no model. The second half of the greeting
  is built from those, and the phone builds the sentence, because the phone is
  what knows the language.
* The same request fires **a warm-up query** in the background and throws the
  answer away.

That warming is not *connecting* was itself a measurement: connecting is already
400 ms, and the three seconds go into the first query. Warming by connecting
alone bought nothing (4.5 s → 5.0 s). A real query nobody reads does:

| first question | median |
|---|---|
| without warm-up | 3883 ms |
| with warm-up | **1217 ms** |

The first question is now as fast as the tenth. The price is one tiny turn per
call.

### Whose turn it is

There is no push-to-talk on a call. You speak, you stop, it goes.

* **Deciding you are done is ours.** iOS wants ~3 seconds of silence, which
  reads less like a pause in a conversation and more like the other side hanging
  up. Recognition runs `continuous`, and every recognised word rewinds an
  1100 ms timer. When the timer runs out, the question goes.
* **Interrupting is just talking.** The microphone stays open while the answer
  is being read; the audio session is opened `playAndRecord` + `voiceChat`, and
  that mode is what turns on echo cancellation.
* **Echo is filtered twice.** If what is heard appears inside what is being
  read, it is the phone's own voice and is ignored (`isEcho`). If it does not,
  you interrupted — but because `continuous` keeps one growing transcript, your
  words can have leftover echo in front of them; `stripEcho` trims those by
  dropping words from the start for as long as they are still part of the
  answer.

The button is still there, but as a shortcut now: "send it now" while listening,
"be quiet" while speaking. Neither is required.

### Who is speaking

Jarvis's voice is Paul Bettany's voice and it is Marvel's; it is not being
cloned. Cloning would also mean a cloud service, which breaks "the voice never
leaves the phone" and adds latency. So the two halves were built separately.

**The voice** is chosen from whatever the device has, never hardcoded: the good
voices are optional downloads (Settings → Accessibility → Spoken Content →
Voices), which means pointing at a voice with no stable identifier. `pickVoice`
asks the phone what it has and scores it — "Enhanced" quality outweighs any
name, because compact voices are what make a synthesiser sound like one. The
English target is **Daniel** (en-GB, male, unhurried): the closest thing Apple
ships to the butler everyone has in mind, free, and nobody's property.

Turkish has one voice, **Yelda**, and she is female. There is no Turkish butler
to pick; if you want the Jarvis register, the call has to be in English. The
screen says which voice it is using, so anyone who dislikes it knows where to
get a better one.

**The register** lives in the prompt: dry, unhurried, slightly formal. No
enthusiasm, no exclamation marks, no "great question". Bad news first and
unsoftened.

That has a measured cost: adding the register made answers longer — the "two
sentences" rule went from five-for-five to four. Repeating it in the prompt did
not help, so `clip()` was added: from the start, on whole sentences, up to a
spoken budget of ~32 words. Because what matters is at the front, what gets cut
is always the colour at the tail. A single long sentence is left alone — half a
sentence is worse than a long one.

### The concierge also does work

Four verbs, all of them an in-process MCP server inside `call.py`: send a
message to an existing session, start a new session in a project, answer an
approval it is waiting on, stop one that is running. There is **no** tool that
reads a file or runs a command — the worst a misheard sentence can do is drop
the wrong instruction into a session. That is visible, and it can be stopped.

Sessions are **numbered** in the snapshot and the tools work by number. Making
the concierge match back the title it just described in its own words would be
guessing, and a wrong guess here means sending a message to the wrong project.

Approving is deliberately limited: a request flagged dangerous cannot be
approved by voice, and it says "you'll have to do that from the app". Approving
`rm -rf` through a sentence that came out of a speech recogniser is not
something to trust a prompt with.

### Why thinking was turned back on

Phase 1 had `thinking: disabled` and the measurement was right: 2.9 s → 1.2 s,
byte-identical answers. Once the tools arrived, the same measurement reversed.

"Tell session one to run the tests" → **"I've sent it a message to run the
tests, sir."** With no tool called at all. The turn looks perfect, nothing
happens, and you put the phone down believing the tests are running.

| | tool accuracy | status question | action |
|---|---|---|---|
| off | 3/4 | ~1.2 s | ~2 s |
| on | **4/4** (7/7 on a rerun) | ~3.5 s | ~3 s |

Two seconds lost on status questions. For something that only narrates that
trade is the wrong way round; being able to do work changed the answer. The
`did` field in the response carries which tools actually ran — the record, not
the claim.
