# Contributing

Thanks for looking. This is a small project with three moving parts that have to
agree with each other, so most of this file is about that agreement.

## The shape of it

```
app/     iOS app        (Expo Router, React Native, zustand)
web/     desktop panel  (React + Vite, built into the daemon)
daemon/  the daemon     (Python 3.11–3.13, websockets, SQLite)
docs/    the protocol, and notes that outlive a session
design/  the artboards the interface was drawn from
```

`docs/PROTOCOL.md` is the contract. Every request, every event, every field.
**If your change touches the wire, change that file in the same commit.** A
client and a daemon that disagree fail in ways that are miserable to debug from
a phone on a bus.

## Getting set up

```bash
cd daemon
uv --no-config venv --python 3.12 .venv312
uv --no-config pip install --python .venv312/bin/python -e .
.venv312/bin/remote-ai-chat pair --name dev     # prints a token
.venv312/bin/remote-ai-chat serve
```

```bash
cd app && npm install --legacy-peer-deps && npx expo run:ios
cd web && npm install && npm run dev            # http://localhost:5177
```

The simulator has no camera. Pair with **Enter IP and token**: `127.0.0.1`,
port `8790`. For the panel, put a `web/public/dev-host.json` in place — it is
gitignored, and it stands in for the token the daemon normally hands over:

```json
{"host": "127.0.0.1", "port": 8790, "token": "…", "name": "This computer", "device_id": "…"}
```

`RAC_HOME=/tmp/rac-dev RAC_PORT=8791` gives you a second daemon with its own
config, database and devices — useful when you do not want to disturb the one
you actually use.

## Before you open a PR

```bash
cd daemon
python scripts/smoke.py --token TOKEN          # 18 protocol checks, no model turns
.venv312/bin/python scripts/test_preamble.py   # session context and register
.venv312/bin/python scripts/test_session.py
.venv312/bin/python scripts/test_stream.py
.venv312/bin/python scripts/test_attachments.py
.venv312/bin/python scripts/test_pool.py

cd app && npx tsc --noEmit
cd web && npm run build                        # typechecks, then builds into the daemon
```

`scripts/e2e.py` is the one that spends real model turns. Run it when you have
touched the session or the provider adapters.

If you changed the panel, commit the rebuilt `daemon/remote_ai_chat/webui/`?
**No** — it is gitignored. The daemon builds it, or the installer does.

## House rules

**Language.** Code, comments, commit messages and documentation are English.
The app is bilingual at runtime (English + Turkish) through `app/src/i18n.ts`;
the daemon speaks only English and tags every user-visible error with a stable
`code` in `daemon/remote_ai_chat/errors.py`, which the clients translate. A new
code means a new entry in `ERR_KEYS` and in both language tables. The desktop
panel is English only.

**Comments explain why.** The codebase leans on comments that say what a piece
of code is defending against, not what the next line does. Match that. A
comment that restates the code is worse than no comment.

**Commit messages are sentences, not labels.** `A reader that outlives the
turn`, not `fix: client.py`. Say what is now true that was not true before.

**No secrets, ever.** Tokens are stored as sha256. Paths under
`~/.remote-ai-chat/` are machine state and are gitignored. `security.py` has a
redaction list for anything key-shaped that reaches a log or a bubble; if you
add a credential format, add the pattern.

**Security changes get their own PR.** The permission policy, the dangerous
command list, `allowed_roots` / `denied_paths`, and anything touching pairing
or tokens. Small, readable, and on its own.

## What is welcome

- Android. The protocol is platform-neutral and `app/` is Expo; the work is
  real but nothing in the design is in the way.
- More provider adapters — `daemon/remote_ai_chat/providers/` is a small
  interface and Claude Code and Codex are both implementations of it.
- Bug reports with the daemon log (`~/.remote-ai-chat/logs/daemon.log`) and what
  the phone showed. Scrub paths you would rather not publish.

## What is not

Anything that puts a server between the phone and the computer. That is the one
design decision the whole project is built around: your machine, your account,
your network, no middle.
