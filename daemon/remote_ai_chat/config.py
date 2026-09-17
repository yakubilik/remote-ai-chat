"""Config + device registry at ~/.remote-ai-chat/config.toml.

Tokens are stored as sha256 hashes; the plaintext only ever leaves via the
pairing QR. Nothing here is logged.
"""
from __future__ import annotations

import os
import hashlib
import secrets
import socket
import subprocess
import sys
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import tomli_w

# RAC_HOME lets a machine host a second, fully separate daemon (own config,
# database, uploads and port) — used for testing and for per-user installs.
CONFIG_DIR = Path(os.environ.get("RAC_HOME") or (Path.home() / ".remote-ai-chat")).expanduser()
CONFIG_PATH = CONFIG_DIR / "config.toml"
DB_PATH = CONFIG_DIR / "db.sqlite"
LOG_DIR = CONFIG_DIR / "logs"
UPLOAD_DIR = CONFIG_DIR / "uploads"

DEFAULT_PORT = 8790


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


@dataclass
class Device:
    id: str
    name: str
    token_hash: str
    created_at: float
    push_token: str | None = None
    last_seen: float | None = None
    push_approval: bool = True
    push_done: bool = True
    lang: str = "en"


@dataclass
class Config:
    host_name: str = field(default_factory=socket.gethostname)
    port: int = DEFAULT_PORT
    bind: list[str] = field(default_factory=lambda: ["auto", "127.0.0.1"])
    allowed_roots: list[str] = field(default_factory=lambda: [str(Path.home() / "projects")])
    # Subtracted from allowed_roots. Anything that holds a credential, plus this
    # daemon's own state — a chat has no business opening in its own token store.
    denied_paths: list[str] = field(default_factory=lambda: [
        str(Path.home() / ".ssh"),
        str(Path.home() / ".aws"),
        str(Path.home() / ".gnupg"),
        str(Path.home() / ".docker"),
        str(Path.home() / "AppData"),          # Windows: creds, tokens, browser profiles
        str(Path.home() / ".config" / "gh"),
        str(CONFIG_DIR),
    ])
    idle_disconnect_s: int = 1800
    approval_timeout_s: int = 900
    # Follow origin/main by itself. Safe to leave on even where the code is
    # written: a checkout with uncommitted work is never touched (see updater).
    auto_update: bool = True
    update_interval_s: int = 900
    devices: dict[str, Device] = field(default_factory=dict)
    accounts: dict[str, dict] = field(default_factory=dict)   # id -> stored fields

    # ── persistence ────────────────────────────────────────────────────────
    @classmethod
    def load(cls) -> "Config":
        if not CONFIG_PATH.exists():
            cfg = cls()
            cfg.save()
            return cfg
        raw = tomllib.loads(CONFIG_PATH.read_text())
        devices = {
            did: Device(id=did, **d) for did, d in raw.pop("devices", {}).items()
        }
        accounts = raw.pop("accounts", {})
        cfg = cls(**{k: v for k, v in raw.items() if k in cls.__dataclass_fields__})
        cfg.devices = devices
        cfg.accounts = accounts
        cfg._devices_mtime = _mtime(CONFIG_PATH)
        return cfg

    def save(self) -> None:
        CONFIG_DIR.mkdir(mode=0o700, exist_ok=True)
        LOG_DIR.mkdir(exist_ok=True)
        data = {
            "host_name": self.host_name,
            "port": self.port,
            "bind": self.bind,
            "allowed_roots": self.allowed_roots,
            "denied_paths": self.denied_paths,
            "idle_disconnect_s": self.idle_disconnect_s,
            "approval_timeout_s": self.approval_timeout_s,
            "devices": {
                d.id: {k: v for k, v in d.__dict__.items() if k != "id" and v is not None}
                for d in self.devices.values()
            },
            "accounts": self.accounts,
        }
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(tomli_w.dumps(data))
        tmp.chmod(0o600)
        tmp.replace(CONFIG_PATH)
        self._devices_mtime = _mtime(CONFIG_PATH)

    # ── devices / tokens ───────────────────────────────────────────────────
    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def add_device(self, name: str) -> tuple[Device, str]:
        token = secrets.token_urlsafe(32)
        dev = Device(
            id=secrets.token_hex(6), name=name,
            token_hash=self.hash_token(token), created_at=time.time(),
        )
        self.devices[dev.id] = dev
        self.save()
        return dev, token

    def find_device_by_token(self, token: str) -> Device | None:
        dev = self._match_token(token)
        if dev is None and self.reload_devices():
            dev = self._match_token(token)
        return dev

    def _match_token(self, token: str) -> Device | None:
        h = self.hash_token(token)
        for d in self.devices.values():
            if secrets.compare_digest(d.token_hash, h):
                return d
        return None

    def reload_devices(self) -> bool:
        """Re-read the device registry if config.toml changed under us (a `pair` or
        `revoke` from the CLI while the daemon is running). Returns True if it did.

        Devices already in memory keep their live fields (push token, last_seen);
        new ones are added and revoked ones dropped."""
        mtime = _mtime(CONFIG_PATH)
        if mtime is None or mtime == getattr(self, "_devices_mtime", None):
            return False
        self._devices_mtime = mtime
        try:
            raw = tomllib.loads(CONFIG_PATH.read_text()).get("devices", {})
        except Exception:
            return False
        for did, d in raw.items():
            if did not in self.devices:
                self.devices[did] = Device(id=did, **d)
        for did in [d for d in self.devices if d not in raw]:
            del self.devices[did]
        return True

    def revoke(self, device_id: str) -> bool:
        if device_id in self.devices:
            del self.devices[device_id]
            self.save()
            return True
        return False

    # ── network ────────────────────────────────────────────────────────────
    def resolve_bind(self) -> list[str]:
        out: list[str] = []
        for b in self.bind:
            if b == "auto":
                ip = tailscale_ip()
                if ip:
                    out.append(ip)
            else:
                out.append(b)
        # dedupe, keep order
        seen: set[str] = set()
        return [x for x in out if not (x in seen or seen.add(x))]


def tailscale_ip() -> str | None:
    """This machine's Tailscale IPv4 (100.64.0.0/10), or None if Tailscale is down."""
    candidates = [["tailscale", "ip", "-4"]]
    if sys.platform == "darwin":
        candidates.append(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"])
    elif sys.platform == "win32":
        candidates.append([r"C:\Program Files\Tailscale\tailscale.exe", "ip", "-4"])
        candidates.append([r"C:\Program Files (x86)\Tailscale\tailscale.exe", "ip", "-4"])
    for cmd in candidates:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            for line in (r.stdout or "").splitlines():
                if _is_tailscale_v4(line.strip()):
                    return line.strip()
        except Exception:
            pass
    # No CLI: read the interface addresses directly.
    try:
        import socket as _s
        for info in _s.getaddrinfo(_s.gethostname(), None, _s.AF_INET):
            ip = info[4][0]
            if _is_tailscale_v4(ip):
                return ip
    except Exception:
        pass
    if sys.platform != "win32":
        try:
            r = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3)
            for line in r.stdout.splitlines():
                line = line.strip()
                if line.startswith("inet 100.") and _is_tailscale_v4(line.split()[1]):
                    return line.split()[1]
        except Exception:
            pass
    return None


def _is_tailscale_v4(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return a == 100 and 64 <= b <= 127
