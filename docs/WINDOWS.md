# Windows

The daemon runs on Windows. Most of it is the same as macOS and Linux; this file
is the parts that are not.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File .\daemon\install.ps1
```

Windows PowerShell 5.1 is enough, and **no administrator rights are needed** for
the default path. The script builds the venv, installs the daemon, sets up
autostart, and prints a pairing QR at the end.

## Reaching it from the phone

`install.ps1` prefers `tailscale serve`: tailscaled listens on
`<tailscale-ip>:8790` itself and forwards to the daemon on `127.0.0.1`, so no
firewall rule is needed and nothing has to be run as administrator.

If the Tailscale CLI is not there, the script falls back to adding an inbound
rule for port 8790 **restricted to the Tailscale range** (`100.64.0.0/10`). That
one does need administrator.

## Autostart

Task Scheduler first. Where group policy forbids it, the installer falls back to
an `HKCU\…\Run` entry pointing at a hidden watchdog,
`%USERPROFILE%\.remote-ai-chat\start.ps1`, which restarts the daemon if it dies
(measured at about two seconds).

Undo all of it:

```powershell
.venv\Scripts\python.exe -m remote_ai_chat uninstall
```

## Managed / corporate machines

- **AppLocker blocks the shims.** The `remote-ai-chat.exe` entry point and npm's
  `.cmd` shims are usually blocked. Everything works through
  `python -m remote_ai_chat ...` instead — use that form. `tools.find_cli` tries
  each candidate with `--version`, so the daemon finds the Claude Agent SDK's
  bundled `claude.exe` on its own.
- **Codex will not run there.** `codex.cmd` is a shim too, and there is no
  bundled fallback.
- **npm may be blocked outright.** `RAC_NO_CLIS=1` skips the CLI install step.
- **Symlinking shared config into account folders needs administrator.** Without
  it the step is skipped silently: accounts still work, but `CLAUDE.md` and
  skills are not carried across.

## Voice transcription

`transcribe.py` carries two backends behind one interface (`available()` /
`transcribe()`): `mlx-whisper` on macOS, `faster-whisper` on Windows and Linux
(CTranslate2, CPU, `int8`, model `small`). It decodes audio itself with PyAV, so
there is no ffmpeg dependency. The dependency is platform-conditional in
`pyproject.toml`.

The model downloads on first use (~480 MB), which makes the first voice message
slow — that call gets a 900 s timeout. After that it stays in memory for the
life of the process. `host.info.transcription` reports `true` once it is
available.

One behavioural difference: the faster-whisper path **auto-detects the language**
(`language=None`). Forcing `language="en"` because the device was set to English
made whisper translate non-English speech instead of transcribing it. The mlx
path still forces the device language; moving it to auto-detection is probably
right too.

Check it with:

```
python scripts/smoke.py --token TOKEN --audio sample.m4a
```

→ `audio upload returns a transcript`.

## Known limitations

- **A `pair` while the daemon is running can be lost.** The CLI writes the new
  device into `config.toml`, but a running daemon holds its own copy in memory
  and can write over it. Pair before starting the daemon, or restart it after.
- Paths are canonicalised case- and slash-insensitively, so `chat.update` puts a
  cwd into the same form `chat.create` did. The folder fence behaves the same as
  on Unix — `AppData` and `C:\Windows` are refused.
