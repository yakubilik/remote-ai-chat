"""CLI: serve | pair | devices | revoke | status"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import sys

from .config import CONFIG_DIR, Config, LOG_DIR, DEFAULT_PORT


def _sanitize_env() -> None:
    """Drop env vars a parent Claude Code session would leak into the CLI
    subprocesses (they point at a session-scoped proxy / expired token)."""
    import os
    for k in list(os.environ):
        if k.startswith(("CLAUDE_CODE_", "CLAUDE_AGENT_SDK", "CLAUDE_PREVIEW")) or k in (
            "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "ANTHROPIC_BASE_URL",
        ):
            os.environ.pop(k, None)


def _already_serving(port: int) -> bool:
    """Is another daemon already answering on this port?"""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return b'"ok":true' in r.read(200)
    except Exception:
        return False


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn
    _sanitize_env()
    from .server import Server

    cfg = Config.load()
    if args.bind:
        cfg.bind = args.bind
    if args.port:
        cfg.port = args.port
    if _already_serving(cfg.port):
        # Windows lets a second process bind the same port (SO_REUSEADDR), so a
        # duplicate daemon does not fail loudly — it quietly shares the SQLite
        # file and config.toml with the first one and they overwrite each other.
        print(f"remote-ai-chat is already running (127.0.0.1:{cfg.port}).", file=sys.stderr)
        return
    binds = cfg.resolve_bind()
    if not binds:
        print("No address to bind to (is Tailscale down?). Try --bind 127.0.0.1.", file=sys.stderr)
        sys.exit(2)
    if not cfg.devices:
        print("No paired device yet. Run: remote-ai-chat pair", file=sys.stderr)

    srv = Server(cfg)

    async def main() -> None:
        servers = []
        for host in binds:
            # uvicorn's own websocket keepalive tears every connection down at
            # exactly ws_ping_interval + ws_ping_timeout, whether or not the
            # client answered the pings — a plain `websockets` client, which
            # pongs for you, dies on the 40s dot the same as the phone does. And
            # the close never reaches the client, so the phone goes on believing
            # it is online while events quietly stop arriving; the backlog only
            # lands when something else finally times out. The phone sends a
            # `ping` request of its own every 15s (see app/src/ws.ts), which is a
            # liveness check we can actually trust: it proves the app is on the
            # other end and this loop is still serving it.
            uc = uvicorn.Config(srv.app, host=host, port=cfg.port, log_level="warning",
                                ws_ping_interval=None, ws_ping_timeout=None)
            servers.append(uvicorn.Server(uc))
        print(f"remote-ai-chat {cfg.host_name} dinliyor: " + ", ".join(f"ws://{h}:{cfg.port}/ws" for h in binds))
        reaper = asyncio.create_task(srv.reaper())
        updater = asyncio.create_task(srv.updater.loop())

        async def stopper() -> None:
            """Stand down once an update has been staged.

            The new code is already on disk by the time this fires; this process
            is the only thing still running the old code. Exiting hands over to
            whatever keeps the daemon alive on this machine — launchd with
            KeepAlive on macOS, start.ps1 on Windows — and it comes back on the
            new commit within seconds.
            """
            await srv.restart_requested.wait()
            print("update staged — stopping so the supervisor can restart us")
            for s in servers:
                s.should_exit = True

        stop = asyncio.create_task(stopper())
        try:
            await asyncio.gather(*(s.serve() for s in servers))
        finally:
            reaper.cancel()
            updater.cancel()
            stop.cancel()
            await srv.sessions.close_all()

    asyncio.run(main())


def cmd_pair(args: argparse.Namespace) -> None:
    cfg = Config.load()
    dev, token = cfg.add_device(args.name)
    # The phone must reach the Tailscale address even when the daemon only binds
    # 127.0.0.1 (Windows without admin: `tailscale serve` forwards to loopback).
    from .config import tailscale_ip
    binds = [b for b in cfg.resolve_bind() if not b.startswith("127.")]
    host = tailscale_ip() or (binds[0] if binds else "127.0.0.1")
    payload = {"v": 1, "host": host, "port": cfg.port, "token": token,
               "name": cfg.host_name, "device_id": dev.id}
    text = json.dumps(payload, separators=(",", ":"))
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(text)
        qr.print_ascii(invert=True)
    except Exception:
        pass
    from urllib.parse import urlencode
    link = "remoteaichat://pair?" + urlencode({"host": host, "port": cfg.port, "token": token,
                                              "name": cfg.host_name, "device_id": dev.id})
    print(f"\nDevice: {dev.name} ({dev.id})  Host: {host}:{cfg.port}")
    print("Token for manual entry (shown once):")
    print(token)
    print("\nOr open this link on the phone:")
    print(link)


def cmd_web(args: argparse.Namespace) -> None:
    """Open the desktop panel in a browser, paired.

    The panel is just another device: it gets its own token, shows up in
    `devices`, and `revoke` cuts it off like it cuts off a phone. The token
    rides in the URL fragment, which browsers never send to a server and which
    the panel wipes out of the address bar once it has stored it.
    """
    from urllib.parse import urlencode
    cfg = Config.load()
    panel = Path(__file__).parent / "webui" / "index.html"
    if not panel.exists():
        print("The panel is not built. Run: cd web && npm install && npm run build")
        return
    if not _already_serving(cfg.port):
        print(f"Nothing answers on port {cfg.port}. Start it first: remote-ai-chat serve")
        return
    dev, token = cfg.add_device(args.name)
    url = f"http://127.0.0.1:{cfg.port}/#" + urlencode({
        "t": token, "h": "127.0.0.1", "p": cfg.port, "n": cfg.host_name, "d": dev.id,
    })
    print(f"Cihaz: {dev.name} ({dev.id})")
    print(url)
    if not args.no_open:
        import webbrowser
        webbrowser.open(url)


def cmd_devices(args: argparse.Namespace) -> None:
    cfg = Config.load()
    if not cfg.devices:
        print("(no devices)")
    for d in cfg.devices.values():
        print(f"{d.id}  {d.name:20s}  push={'yes' if d.push_token else 'no'}")


def cmd_revoke(args: argparse.Namespace) -> None:
    cfg = Config.load()
    print("revoked" if cfg.revoke(args.device_id) else "no such device")


PLIST_LABEL = "com.remote-ai-chat.daemon"


def _plist_path():
    from pathlib import Path
    return Path.home() / "Library" / "LaunchAgents" / f"{PLIST_LABEL}.plist"


WIN_RUN_KEY = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
WIN_TASK = "remote-ai-chat"


def _win_uninstall() -> None:
    """Undo what daemon/install.ps1 set up: autostart (task or Run key), the
    Tailscale Serve forward, and the running daemon. No admin needed."""
    import subprocess
    from pathlib import Path
    cfg = Config.load()
    subprocess.run(["reg", "delete", WIN_RUN_KEY, "/v", WIN_TASK, "/f"], capture_output=True)
    subprocess.run(["schtasks", "/Delete", "/TN", WIN_TASK, "/F"], capture_output=True)
    for ts in ("tailscale", r"C:\Program Files\Tailscale\tailscale.exe"):
        r = subprocess.run([ts, "serve", f"--tcp={cfg.port}", "off"], capture_output=True)
        if r.returncode == 0:
            break
    # The supervisor (start.ps1) restarts the daemon on exit, so stop it first.
    # Only the daemon (python -m remote_ai_chat serve) and its launcher
    # (powershell -File ...\start.ps1): match name + exact argument shape so a
    # shell or editor that merely mentions these strings is never killed.
    import os
    ps = ("Get-CimInstance Win32_Process | Where-Object { "
          "(($_.Name -match '^python' -and $_.CommandLine -match '-m remote_ai_chat serve') -or "
          "($_.Name -match '^powershell' -and $_.CommandLine -match '-File .*\\\\start\\.ps1')) "
          f"-and $_.ProcessId -ne {os.getpid()} }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
    launcher = Path(LOG_DIR).parent / "start.ps1"
    launcher.unlink(missing_ok=True)
    print("Removed: autostart, tailscale serve, and the running daemon.")


def cmd_install(args: argparse.Namespace) -> None:
    """Register the daemon so it starts with the machine and restarts on crash.

    macOS uses a launchd agent, Linux a systemd --user unit. On Windows the
    logon task is created by install.ps1, which also handles the firewall."""
    if sys.platform == "linux":
        return _install_systemd()
    if sys.platform == "win32":
        print("Windows'ta bunun yerine: powershell -ExecutionPolicy Bypass -File .\\daemon\\install.ps1",
              file=sys.stderr)
        sys.exit(2)
    import plistlib, subprocess
    from pathlib import Path
    exe = Path(sys.argv[0]).resolve()
    plist = {
        "Label": PLIST_LABEL,
        "ProgramArguments": [str(exe), "serve"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "WorkingDirectory": str(Path.home()),
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
        "EnvironmentVariables": {
            "PATH": str(Path.home() / ".local/bin") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(Path.home()),
        },
    }
    path = _plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        plistlib.dump(plist, f)
    uid = subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip()
    import time
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{PLIST_LABEL}"], capture_output=True)
    # bootout is asynchronous; a bootstrap right after it can fail with EIO. Retry briefly.
    for attempt in range(6):
        time.sleep(1)
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(path)], capture_output=True, text=True)
        if r.returncode == 0:
            break
    else:
        print("launchctl bootstrap failed:", r.stderr.strip(), file=sys.stderr); sys.exit(1)
    print(f"Installed and started: {path}\nLogs: {LOG_DIR}/launchd.*.log")


SYSTEMD_UNIT = Path.home() / ".config" / "systemd" / "user" / "remote-ai-chat.service"


def _install_systemd() -> None:
    import subprocess
    exe = Path(sys.argv[0]).resolve()
    SYSTEMD_UNIT.parent.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    SYSTEMD_UNIT.write_text(f"""[Unit]
Description=remote-ai-chat daemon
After=network-online.target

[Service]
ExecStart={exe} serve
Environment=RAC_HOME={CONFIG_DIR}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
""")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    r = subprocess.run(["systemctl", "--user", "enable", "--now", "remote-ai-chat.service"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("systemctl failed:", r.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    subprocess.run(["loginctl", "enable-linger", os.environ.get("USER", "")], capture_output=True)
    print(f"Installed and started: {SYSTEMD_UNIT}")


def _uninstall_systemd() -> None:
    import subprocess
    subprocess.run(["systemctl", "--user", "disable", "--now", "remote-ai-chat.service"], capture_output=True)
    if SYSTEMD_UNIT.exists():
        SYSTEMD_UNIT.unlink()
    print("Removed.")


def cmd_uninstall(args: argparse.Namespace) -> None:
    if sys.platform == "linux":
        return _uninstall_systemd()
    if sys.platform == "win32":
        print("Windows'ta: Unregister-ScheduledTask -TaskName remote-ai-chat", file=sys.stderr)
        sys.exit(2)
    import subprocess
    if sys.platform == "win32":
        _win_uninstall()
        return
    uid = subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{PLIST_LABEL}"], capture_output=True)
    path = _plist_path()
    if path.exists():
        path.unlink()
    print("Removed.")


def cmd_status(args: argparse.Namespace) -> None:
    cfg = Config.load()
    print(f"host={cfg.host_name} port={cfg.port} bind={cfg.resolve_bind()} devices={len(cfg.devices)}")
    print(f"roots={cfg.allowed_roots}")


def main() -> None:
    p = argparse.ArgumentParser(prog="remote-ai-chat")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve"); s.add_argument("--bind", nargs="*"); s.add_argument("--port", type=int)
    s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("pair"); s.add_argument("--name", default="iPhone"); s.set_defaults(fn=cmd_pair)
    s = sub.add_parser("web", help="open the desktop panel in a browser")
    s.add_argument("--name", default="Panel"); s.add_argument("--no-open", action="store_true")
    s.set_defaults(fn=cmd_web)
    s = sub.add_parser("devices"); s.set_defaults(fn=cmd_devices)
    s = sub.add_parser("revoke"); s.add_argument("device_id"); s.set_defaults(fn=cmd_revoke)
    s = sub.add_parser("status"); s.set_defaults(fn=cmd_status)
    s = sub.add_parser("install", help="start automatically at login"); s.set_defaults(fn=cmd_install)
    s = sub.add_parser("uninstall"); s.set_defaults(fn=cmd_uninstall)
    args = p.parse_args()
    if sys.platform == "win32":
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(),
                                  logging.FileHandler(LOG_DIR / "daemon.log")])
    args.fn(args)


if __name__ == "__main__":
    main()
