# What this session is running inside

Read this when someone asks how any of it works. The four facts a session needs
to not be *wrong* about itself are already in its system prompt; everything here
is the detail behind them.

## The shape of it

An iOS app talks to a daemon on the computer. The daemon starts one CLI session
per chat — Claude Code through `claude_agent_sdk`, or Codex through its
`app-server` — and relays the stream back to the phone.

```
iPhone app  ──WebSocket /ws──▶  daemon (~/projects/remote-ai-chat/daemon)
                                   └── claude / codex CLI, one per chat
```

There is no cloud in the middle. Nothing is relayed through a third party; the
phone reaches the computer directly over the local network or a tailnet.

Two things this is **not**, both of which sessions have confused it with:

* **Some other bridge or bot.** If your instructions describe a Telegram bot, a
  chat relay or a workspace layout that is not the one above, they are
  describing a different project that happens to share this machine. A session
  started by this daemon has the working directory and roots named in its own
  `<session-context>` block, and nothing else.

## Runtime

* Port **8790**, bound to `auto` (the LAN/tailnet address) plus `127.0.0.1`.
* Config and state: `~/.remote-ai-chat/` — `config.toml`, `db.sqlite`
  (`chats`, `events`, `groups`, `limits`), `logs/daemon.log`, `uploads/`,
  `accounts/`, `agent-store/`.
* Devices are paired by token; only the hash is stored. Each has its own push
  token and language.
* Push goes through Expo (`exp.host`) and is **content-free by design** — no
  message text leaves the computer.
* Voice notes are transcribed locally: `mlx-whisper` on Apple silicon,
  `faster-whisper` on Windows and Linux. The first one is slow (model download).
  Transcription artifacts in a message are transcription artifacts, not intent.
* An idle chat is reaped after `idle_disconnect_s` (default 1800s); an unanswered
  permission request expires after `approval_timeout_s` (default 900s).

## Accounts

Each signed-in account gets `~/.remote-ai-chat/accounts/<tool>-<hex>/` and the
session runs with `CLAUDE_CONFIG_DIR` (or `CODEX_HOME`) pointed at it. That is
what makes one subscription distinct from another on the same computer.

`CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands` and `plugins` are
symlinked from the computer's own `~/.claude` into each account, so a second
subscription sees the same instructions and skills as the first. Configuration
is shared that way; credentials never are.

**Nothing writes into `~/.claude` itself.** An agent that carries skills can only
be installed into an account added in the app, which has a folder of its own.
This is a decision, not an oversight: the user's own setup is not this project's
to fill. If a change here seems to want a file in `~/.claude/skills`, it wants
something else instead.

## Staying on one version

Every computer running the daemon follows `origin/main`. Neither machine updates
the other. Installs are `pip install -e`, so a pull *is* the update, and
dependencies are reinstalled only when `pyproject.toml` changed. The update ends
by asking the server to stop; launchd (`KeepAlive`) on macOS and `start.ps1` on
Windows bring it back on the new code within seconds.

The updater will not touch a repository with uncommitted work in it, and will
only fast-forward. So **the development machine, mid-change, does not
auto-update** — that is deliberate, and it means the machine you are on can be
behind or ahead of the other one while work is in flight.

## Reach

`allowed_roots` in `config.toml` is what the app will open (default
`~/projects`). `denied_paths` covers `~/.ssh`, `~/server` and
`~/.remote-ai-chat` itself. In `bypass` permission mode there is no hook in the
way; in every other mode a `PreToolUse` hook checks Bash commands and anything
destructive goes to the phone for approval.

## Where the session's own instructions come from

* `daemon/remote_ai_chat/preamble.py` — builds the `<session-context>` block
  from live values, per session.
* `daemon/remote_ai_chat/house_style.md` — the register, read fresh each time,
  so an edit lands on the next chat rather than the next restart.
* This file — the detail, read only when asked for.

All three are in the repository rather than in a machine's settings, so every
computer gets them from the same pull.
