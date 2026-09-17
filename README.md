# remote-ai-chat

**Your own computer's coding agent, from your phone.** Not a hosted copy of it —
the actual `claude` or `codex` process on your machine, in your repo, signed in
with your own account, reached over your own private network.

<p align="center">
  <img src="docs/screenshots/chat.png" width="250" alt="A chat: the agent has read a file and answered">
  <img src="docs/screenshots/approval.png" width="250" alt="An approval: rm -rf waiting for a decision">
  <img src="docs/screenshots/chats.png" width="250" alt="The chat list, grouped by project">
</p>

---

## Why this exists

The agent that can actually change your code lives on your laptop. It has your
repo, your branch, your uncommitted work, your logins, your `node_modules`. It
is also, for that exact reason, chained to your desk.

So you have the idea on the bus, and you write it down, and by the time you are
back at the desk it is smaller than it was. Or the build breaks while you're
out, and you know the fix, and you cannot type it anywhere that matters.

The usual answer is to move the work to someone else's computer. This is the
other answer: leave the work where it is and move the *keyboard*. A small daemon
sits on your machine and speaks WebSocket over your tailnet. The phone is a
client. The agent never leaves home.

What that gets you, in practice:

- **You approve, it runs.** `rm -rf` shows up on your lock screen with the exact
  command. You tap Allow or Deny from the bus. Nothing runs while you decide.
- **Your plan, your account.** No API key in the middle. The daemon drives the
  CLI you already signed into, and the app shows how much of your 5-hour window
  you have left.
- **Turns survive the tunnel.** Close the app, lose signal, get on the subway —
  the turn keeps running on the computer, and the phone catches up on reconnect.
- **Voice, because a bus is not a desk.** Record a message and the computer
  transcribes it; the agent gets text, and the bubble keeps the audio.

---

## What it looks like

| | |
|---|---|
| <img src="docs/screenshots/chats.png" width="230"> | **Chats, grouped by project.** One row per conversation, with the model, the effort and the permission mode it is running under. Archive, pin, rename, search. |
| <img src="docs/screenshots/chat.png" width="230"> | **A turn, streaming.** Text arrives token by token; a run of tool calls folds into one line until you ask for it. The footer is what the turn actually cost. |
| <img src="docs/screenshots/approval.png" width="230"> | **The approval.** In `ask` mode every shell command stops here. A dangerous one stops here even in `bypass`. |
| <img src="docs/screenshots/new-chat.png" width="230"> | **Starting one.** Pick the tool, the model, how hard it should think, how much rope it gets, and which folder it opens in. |
| <img src="docs/screenshots/settings.png" width="230"> | **Settings.** Several computers, several sign-ins per tool, and a daemon that follows `origin/main` on its own. |

### And a desktop panel

The phone talks to one computer at a time. The panel talks to **all of them at
once** — the answer to "what is running where". It ships with the daemon; no
separate server.

![The desktop panel](docs/screenshots/panel-dashboard.png)

![A chat in the panel](docs/screenshots/panel-chat.png)

---

## Install

On every computer you want to reach:

**macOS / Linux**

```bash
git clone https://github.com/yakubilik/remote-ai-chat.git
cd remote-ai-chat/daemon && ./install.sh
```

**Windows** (Windows PowerShell 5.1 is enough; no administrator needed)

```powershell
powershell -ExecutionPolicy Bypass -File .\daemon\install.ps1
```

The script builds a virtualenv, installs the daemon, registers it to start at
login (launchd / systemd `--user` / Task Scheduler, falling back to an `HKCU
Run` entry where there is no permission), offers to install the `claude` and
`codex` CLIs with npm, and finishes by printing a pairing link.

Then install the app on your phone (`app/`, Expo — see below), scan the QR, and
you are connected.

**Requirements:** Python 3.11–3.13, and Tailscale connected. `RAC_NO_CLIS=1`
skips the CLI install, `RAC_YES=1` answers every prompt with yes, and
`RAC_HOME` + `RAC_PORT` let one machine host a second, fully separate daemon.

Sign-ins are not the installer's job: you add accounts from the phone
(Settings → Accounts) and it walks you through the browser flow.

### Runs on

| | Daemon | Login service | Image resize | Voice transcription |
|---|---|---|---|---|
| macOS | ✓ | launchd | `sips` | mlx-whisper (Apple silicon) |
| Linux | ✓ | systemd `--user`, else manual | Pillow | faster-whisper (CPU) |
| Windows | ✓ | Task Scheduler, else `HKCU Run` + a watchdog | Pillow (+pillow-heif) | faster-whisper (CPU) |

The phone app is iOS. Both CLIs install through npm on every platform.

---

## How it is put together

```
phone (Expo / React Native)  ─┐
                              ├─ WebSocket ─→  daemon (Python)  ─→  claude / codex CLI
desktop panel (React/Vite)   ─┘                      │
                                                     └─ SQLite + uploads in ~/.remote-ai-chat
```

| | |
|---|---|
| `daemon/` | The Python daemon: WebSocket server, session manager, permission policy, provider adapters for Claude Code and Codex, push, transcription, self-update. |
| `app/` | The iOS app (Expo Router, zustand). Bilingual — English by default, Turkish in Settings. |
| `web/` | The desktop panel (React + Vite). Built into `daemon/remote_ai_chat/webui/` and served by the daemon itself. |
| `design/` | The artboards the interface was drawn from, as standalone HTML. |
| `docs/PROTOCOL.md` | Every request and every event on the wire. Read this before changing either client. |

### The daemon

```bash
cd daemon
uv --no-config venv --python 3.12 .venv312
uv --no-config pip install --python .venv312/bin/python -e . "mlx-whisper>=0.4"

.venv312/bin/remote-ai-chat pair --name iPhone   # QR + token + deep link
.venv312/bin/remote-ai-chat serve                # ws://<tailscale-ip>:8790/ws
.venv312/bin/remote-ai-chat web                  # open the desktop panel, paired
.venv312/bin/remote-ai-chat devices | revoke <id> | status | install | uninstall
```

Python 3.11–3.13, and 3.12 is what this is actually run on — the constraint
has always been mlx-whisper, which does voice transcription on Apple silicon and
whose own dependencies have been slow to follow new Python releases. The first
voice message downloads
`mlx-community/whisper-small-mlx` (~500 MB); on Windows and Linux it is
`faster-whisper` on the CPU instead (~480 MB). Audio is decoded with
`afconvert`, so there is no ffmpeg dependency.

### The app

```bash
cd app && npm install --legacy-peer-deps
npx expo start                                        # Expo Go
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo run:ios  # dev build (CocoaPods needs the locale)
npx expo run:ios --device                             # a real phone, over USB
```

There is no camera in the simulator, so pair with **"Enter IP and token"**:
host `127.0.0.1`, port `8790`.

`app.json` deliberately carries no account of its own: the bundle identifier is
`com.example.remoteaichat` and there is no Apple team, Expo owner or EAS project
in it. To ship a build, add your own:

```jsonc
"ios":   { "bundleIdentifier": "com.you.remoteaichat", "appleTeamId": "…" },
"owner": "your-expo-account",
"extra": { "eas": { "projectId": "…" } }
```

### The panel

```bash
cd web && npm install
npm run dev      # http://localhost:5177
npm run build    # → daemon/remote_ai_chat/webui/
```

---

## Security

This is a program that runs shell commands on your computer when your phone
tells it to. The whole design is about that sentence being safe to say.

- **It does not listen on the internet.** The daemon binds the Tailscale
  address and `127.0.0.1`, nothing else. There is no relay, no account, no
  cloud. Your phone reaches your computer or it reaches nothing.
- **Tokens are hashed.** Only a sha256 lives in `config.toml`; the plaintext
  leaves exactly once, in the pairing QR. `revoke <id>` cuts a device off.
  Five bad attempts from one IP in ten minutes earns a lockout.
- **Folders are fenced.** A chat can only open under `allowed_roots`, and
  `denied_paths` (`~/.ssh`, `~/.aws`, credential stores) is subtracted from
  that. The fence is enforced in the daemon, so it holds in `bypass` mode too.
- **Dangerous commands always ask.** There is a pattern list — `rm -rf`,
  `git push --force`, `dd of=/dev/…` — that asks for approval regardless of
  permission mode, and it can be answered from the lock screen.
- **Output is scrubbed.** Anything shaped like an API key or a bot token is
  redacted before it is stored or sent.
- **Face ID** can lock the app, and can be required before entering bypass mode.

One default worth knowing about: **the daemon updates itself.** `auto_update` is
on, and every 15 minutes it fast-forwards its own checkout to `origin/main` and
asks its supervisor to restart it. That is how a laptop you are not sitting in
front of stays on the same commit as the one you are. It refuses to touch a
checkout with uncommitted work, only ever fast-forwards, never interrupts a
running turn, and never waits on a credential prompt. Set `auto_update = false`
in `~/.remote-ai-chat/config.toml` and it never touches git at all.

It does not defend against someone who already has your unlocked phone, or
against the model being wrong in a way you approve. Read what you approve.

Found something? See [SECURITY.md](SECURITY.md).

---

## Tests

```bash
cd daemon
python scripts/smoke.py --token TOKEN [--cwd ~/projects] [--audio sample.m4a]
```

Protocol checks that spend no model turns: host info, cwd policy,
upload/`/files`, archive, delete. Run it right after installing; `--audio` adds
the transcription round-trip.

```bash
.venv312/bin/python scripts/e2e.py --token TOKEN --image ~/.remote-ai-chat/uploads/<chat>/<img>.jpg
```

End-to-end checks — resume, deny, interrupt, attachments, groups, archive,
delete. This one spends a few real turns.

```bash
.venv312/bin/python scripts/test_preamble.py [--live]
.venv312/bin/python scripts/test_session.py
.venv312/bin/python scripts/test_stream.py
```

---

## Language

The app defaults to English; Turkish is a switch in Settings
(`app/src/i18n.ts`). The daemon speaks only English and tags every error the
phone can see with a stable `code` (`daemon/remote_ai_chat/errors.py`); the app
translates it (`app/src/ws.ts`). Adding a code means adding it to `ERR_KEYS` and
to both tables. Push notifications follow the device's language. The desktop
panel is English only.

## Media

- Photos, camera, video and files go through `+`. The file is uploaded with
  `POST /upload` and rendered from `GET /files?path&token`, which only ever
  serves out of `~/.remote-ai-chat/uploads`.
- A voice message is recorded as m4a, transcribed on the computer, and reaches
  the model as text. The bubble keeps both the player and the transcript.
- The agent reads uploaded files with `Read` — no approval is asked for the
  upload folder.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `docs/PROTOCOL.md` is the
contract between the three pieces, and a change that touches the wire should
change that file in the same commit.

## License

[MIT](LICENSE). The vendor logos in `app/assets/` are not covered by it — see
[NOTICE](NOTICE.md).

This project is not affiliated with Anthropic or OpenAI.
