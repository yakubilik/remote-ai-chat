# daemon

The part that runs on the computer. It owns the WebSocket, the chats, the
permission policy and the CLI sessions; the phone and the desktop panel are both
just clients of it.

See the [repository README](../README.md) for what the project is, and
[docs/PROTOCOL.md](../docs/PROTOCOL.md) for every request and event on the wire.

## Install

```bash
./install.sh                    # macOS / Linux: venv, login service, pairing QR
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Or by hand:

```bash
uv --no-config venv --python 3.12 .venv312
uv --no-config pip install --python .venv312/bin/python -e . "mlx-whisper>=0.4"
```

Python 3.11–3.13; 3.12 is the version this is run on. Newer Pythons are
usually held back by mlx-whisper's dependency chain rather than by anything
here, so if you do not need voice transcription any supported version is fine.

## Commands

```
remote-ai-chat pair --name iPhone   # QR + token + deep link
remote-ai-chat serve                # ws://<tailscale-ip>:8790/ws and 127.0.0.1
remote-ai-chat web                  # open the desktop panel, paired
remote-ai-chat devices              # every paired device
remote-ai-chat revoke <id>          # cut one off
remote-ai-chat status
remote-ai-chat install | uninstall  # the login service
```

`RAC_HOME` and `RAC_PORT` give one machine a second, fully separate daemon —
its own config, database, uploads and port. That is what the tests run against.

## Layout

| | |
|---|---|
| `server.py` | The WebSocket endpoint, every request handler, the HTTP upload/file routes. |
| `session.py` | One chat's CLI session: turns, queueing, interrupts, resume. |
| `providers/` | `claude.py` and `codex.py` — the two adapters, behind one interface. |
| `security.py` | Dangerous-command patterns, the path fence, secret redaction. |
| `config.py` | `config.toml`, devices, token hashes, `allowed_roots`. |
| `agents.py` | Agent definitions, and the store that lists them. |
| `updater.py` | Follows `origin/main` and lets the supervisor restart it. |
| `push.py`, `transcribe.py`, `errors.py`, `preamble.py`, `db.py` | The rest. |

## Tests

```bash
python scripts/smoke.py --token TOKEN [--cwd ~/projects] [--audio sample.m4a]
python scripts/e2e.py   --token TOKEN --image <an uploaded file>
python scripts/test_preamble.py [--live]
python scripts/test_session.py
python scripts/test_stream.py
```

`smoke.py` spends no model turns and is the one to run right after installing.
`e2e.py` spends a few real ones.
