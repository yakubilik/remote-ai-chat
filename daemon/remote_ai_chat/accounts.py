"""Multiple Claude / Codex logins on one computer.

Each account is a separate CLI configuration home:
  Claude → CLAUDE_CONFIG_DIR, Codex → CODEX_HOME.
The machine's own existing login is exposed as the built-in "default" account,
which uses the CLI's normal home (no env override).

Logging in works from the phone: the CLI is run on a pty, the login URL (and,
for Codex, the one-time code) is streamed to the app, and for Claude the code
the user pastes back is written into the pty.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time

if sys.platform != "win32":
    import pty
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import CONFIG_DIR
from .errors import Err
from . import tools

log = logging.getLogger("rac.accounts")

ACCOUNTS_DIR = CONFIG_DIR / "accounts"
DEFAULT_ID = "default"

URL_RE = re.compile(r"https://[^\s\x1b\]]+")
CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b")
# Only these hosts may be shown to the phone as a login destination.
LOGIN_HOSTS = {"claude.com", "www.claude.com", "platform.claude.com",
               "console.anthropic.com", "auth.anthropic.com",
               "auth.openai.com", "chatgpt.com", "platform.openai.com"}
MAX_LOGINS = 3            # concurrent login sessions per daemon

# Every way each tool can be signed in. The app shows these; the ids are the
# contract. `code` means the phone hands a code back, `key` means the phone
# sends a key instead of driving a browser, `here` means the browser opens on
# the computer itself and the phone only waits.
LOGIN_METHODS: dict[str, list[dict]] = {
    "claude": [
        {"id": "subscription", "wants_email": True, "needs_code": True},
        {"id": "console", "wants_email": True, "needs_code": True},
        {"id": "sso", "wants_email": True, "needs_code": True},
        {"id": "api_key", "needs_key": True},
    ],
    "codex": [
        {"id": "device", "needs_code": False},
        {"id": "browser_here", "needs_code": False, "here": True},
        {"id": "api_key", "needs_key": True},
    ],
}


def methods_for(provider: str) -> list[dict]:
    return [dict(m) for m in LOGIN_METHODS.get(provider, [])]


def default_method(provider: str) -> str:
    return LOGIN_METHODS[provider][0]["id"] if provider in LOGIN_METHODS else ""


def method_spec(provider: str, method: str) -> dict:
    for m in LOGIN_METHODS.get(provider, []):
        if m["id"] == method:
            return m
    raise Err("unknown_method", "that sign-in method is not available")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)?")


class _PosixPty:
    """The CLI on a real pty (macOS / Linux)."""

    def __init__(self, cmd: list[str], env: dict[str, str]):
        self.master, slave = pty.openpty()
        self.proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave,
                                     close_fds=True, env=env, start_new_session=True)
        os.close(slave)

    def read(self) -> bytes | None:
        """Blocking. b"" at EOF."""
        try:
            return os.read(self.master, 65536)
        except OSError:
            return b""

    def write(self, data: bytes) -> None:
        os.write(self.master, data)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def kill(self) -> None:
        if self.alive():
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:
                self.proc.terminate()

    def close(self) -> None:
        try:
            os.close(self.master)
        except OSError:
            pass


class _WinPty:
    """The CLI on a ConPTY through pywinpty (Windows has no `pty` module).
    `.cmd` shims (npm installs) need cmd.exe in front; the SDK-bundled
    claude.exe runs directly."""

    def __init__(self, cmd: list[str], env: dict[str, str]):
        from winpty import PtyProcess
        if cmd[0].lower().endswith((".cmd", ".bat")):
            cmd = ["cmd.exe", "/c", *cmd]
        self.proc = PtyProcess.spawn(cmd, env=env, dimensions=(40, 160))

    def read(self) -> bytes | None:
        """b"" at EOF, None when there is nothing to read yet."""
        try:
            s = self.proc.read(65536)
        except EOFError:
            return b""
        except Exception:
            return b"" if not self.proc.isalive() else None
        if not s:
            if not self.proc.isalive():
                return b""
            time.sleep(0.05)
            return None
        return s.encode("utf-8", "replace")

    def write(self, data: bytes) -> None:
        self.proc.write(data.decode("utf-8", "replace"))

    def alive(self) -> bool:
        return self.proc.isalive()

    def kill(self) -> None:
        if self.alive():
            try:
                self.proc.terminate(force=True)
            except Exception:
                pass

    def close(self) -> None:
        try:
            self.proc.close()
        except Exception:
            pass


def _spawn_pty(cmd: list[str], env: dict[str, str]):
    return _WinPty(cmd, env) if sys.platform == "win32" else _PosixPty(cmd, env)


@dataclass
class Account:
    id: str
    provider: str                 # claude | codex
    label: str
    created_at: float = field(default_factory=time.time)
    # None for the built-in account: it uses the CLI's own home
    home: str | None = None
    # a sign-in copied from another computer: revoking it there would sign that
    # computer out too, so this account is only ever cleared locally
    imported: bool = False
    # signed in with a key rather than an account: the tool reads it from the
    # environment, so it is kept here rather than in the tool's own store
    api_key: str | None = None
    # filled in by refresh()
    logged_in: bool = False
    detail: str = ""              # e-mail or plan, whatever the CLI reports
    # the tier the sign-in is on ("max", "pro", "team", "api", …). The phone
    # shows it above the chat, so what is being spent is visible before it
    # is spent; empty when the CLI does not say.
    plan: str = ""

    def env(self) -> dict[str, str]:
        """Environment for running this account's CLI."""
        e = dict(os.environ)
        e.pop("CLAUDE_CODE_ENTRYPOINT", None)
        if self.home:
            Path(self.home).mkdir(parents=True, exist_ok=True)
            if self.provider == "claude":
                e["CLAUDE_CONFIG_DIR"] = self.home
            else:
                e["CODEX_HOME"] = self.home
        if self.api_key and self.provider == "claude":
            e["ANTHROPIC_API_KEY"] = self.api_key
        elif self.provider == "claude":
            # an inherited key would silently sign in an account that is not
            e.pop("ANTHROPIC_API_KEY", None)
        return e

    def public(self) -> dict:
        return {"id": self.id, "provider": self.provider, "label": self.label,
                "logged_in": self.logged_in, "detail": self.detail, "plan": self.plan,
                "imported": self.imported, "has_key": bool(self.api_key),
                "is_default": self.home is None}


def default_accounts() -> list[Account]:
    return [
        Account(id=DEFAULT_ID + "-claude", provider="claude", label="This computer's account"),
        Account(id=DEFAULT_ID + "-codex", provider="codex", label="This computer's account"),
    ]


def refresh(acc: Account) -> Account:
    """Ask the CLI whether this account is signed in. Never raises."""
    acc.logged_in, acc.detail, acc.plan = False, "", ""
    try:
        if acc.provider == "claude":
            cli = tools.find_cli("claude")
            if not cli:
                acc.detail = "the claude CLI is not installed"
                return acc
            r = subprocess.run([cli, "auth", "status"], capture_output=True, text=True,
                               timeout=25, env=acc.env())
            data = json.loads(r.stdout or "{}")
            acc.logged_in = bool(data.get("loggedIn"))
            acc.detail = data.get("email") or data.get("authMethod") or ""
            # a key bills API usage and has no tier at all; saying "api" is
            # the honest answer there, not a blank.
            acc.plan = str(data.get("subscriptionType") or "").strip().lower()
            if not acc.plan and acc.logged_in:
                acc.plan = "api" if (acc.api_key or data.get("apiProvider") not in (None, "firstParty")
                                     or data.get("authMethod") not in (None, "claude.ai")) else ""
        else:
            cli = tools.find_cli("codex")
            if not cli:
                acc.detail = "the codex CLI is not installed"
                return acc
            if acc.home:
                Path(acc.home).mkdir(parents=True, exist_ok=True)
            r = subprocess.run([cli, "login", "status"], capture_output=True, text=True,
                               timeout=25, env=acc.env())
            out = (r.stdout or "") + (r.stderr or "")
            acc.logged_in = "Logged in" in out
            acc.detail = out.strip().splitlines()[0][:80] if out.strip() else ""
            m = re.search(r"\(([^)]{1,20})\)", acc.detail)
            if acc.logged_in:
                acc.plan = (m.group(1).strip().lower() if m
                            else "api" if acc.api_key else "")
    except Exception as exc:
        acc.detail = str(exc)[:80]
    return acc


class LoginSession:
    """One in-flight CLI login, driven from the phone.

    The pty is read by a dedicated thread — an event-loop read with a timeout
    abandons a blocked `os.read` and loses whatever it later returns, which
    matters because Codex prints nothing for minutes while it polls.
    """

    def __init__(self, account: Account, emit: Callable[[str, dict], Awaitable[None]],
                 email: str | None = None, method: str | None = None,
                 api_key: str | None = None):
        self.account = account
        self.emit = emit
        self.method = method or default_method(account.provider)
        self.spec = method_spec(account.provider, self.method)
        self.api_key = (api_key or "").strip() or None
        if self.spec.get("needs_key") and not self.api_key:
            raise Err("key_required", "paste the key for that sign-in method")
        # Pre-fills the address on the sign-in page, so the code goes to the
        # right mailbox and the user does not type it on a phone keyboard.
        self.email = (email or "").strip() or None
        self.pty: _PosixPty | _WinPty | None = None
        self.lines: list[str] = []     # complete lines only; partials wait
        self._partial = ""
        self.url: str | None = None
        self.code: str | None = None
        self.needs_code = bool(self.spec.get("needs_code"))
        self.done = False
        self.started_at = time.time()
        self.ok = False
        self.error: str | None = None
        self.error_code: str | None = None
        self.expires_at = 0.0
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._reader: threading.Thread | None = None

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        cli = tools.find_cli(self.account.provider)
        if not cli:
            raise Err("cli_missing", f"the {self.account.provider} CLI is not installed")
        cmd = self._command(cli)
        env = self.account.env()
        env.update({"TERM": "xterm-256color", "FORCE_COLOR": "0", "NO_COLOR": "1"})
        if self.spec.get("here"):
            # the point of this method is the browser opening on the computer
            env.pop("BROWSER", None)
        else:
            # keep the sign-in inside the phone: no window should pop up there
            env.update({"BROWSER": "/usr/bin/true", "DISPLAY": ""})
        # a key belonging to the shell must never leak into an account's login
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("OPENAI_API_KEY", None)
        log.info("login start account=%s method=%s cmd=%s", self.account.id, self.method, cmd[1:])
        self.pty = _spawn_pty(cmd, env)
        self.expires_at = time.time() + 15 * 60
        if self.spec.get("needs_key"):
            # `codex login --with-api-key` reads the key from its input
            self.pty.write((self.api_key + "\n").encode())
        loop = asyncio.get_running_loop()
        self._reader = threading.Thread(target=self._read_forever, args=(loop, self.pty), daemon=True)
        self._reader.start()
        self._task = asyncio.create_task(self._pump())

    def _command(self, cli: str) -> list[str]:
        p = self.account.provider
        if p == "claude":
            flag = {"subscription": "--claudeai", "console": "--console", "sso": "--sso"}.get(self.method)
            if flag is None:
                # a key is not a browser flow; the server stores it instead
                raise Err("unknown_method", "that sign-in method is not available")
            return [cli, "auth", "login", flag] + (["--email", self.email] if self.email else [])
        if self.method == "api_key":
            return [cli, "login", "--with-api-key"]
        if self.method == "browser_here":
            return [cli, "login"]
        return [cli, "login", "--device-auth"]

    def _read_forever(self, loop: asyncio.AbstractEventLoop, tty) -> None:
        """Blocking reads on their own thread; every byte reaches the queue."""
        try:
            while True:
                chunk = tty.read()
                if chunk is None:          # nothing yet (Windows), keep polling
                    continue
                if not chunk:
                    break
                loop.call_soon_threadsafe(self._queue.put_nowait, chunk)
        finally:
            loop.call_soon_threadsafe(self._queue.put_nowait, None)

    async def _pump(self) -> None:
        try:
            while True:
                if self.pty and not self.pty.alive():
                    await asyncio.sleep(0.2)          # let the last output arrive
                    await self._drain_nowait()
                    await self._finish()
                    return
                try:
                    chunk = await asyncio.wait_for(self._queue.get(), 2)
                except asyncio.TimeoutError:
                    if time.time() > self.expires_at:
                        self.error, self.error_code = "the sign-in timed out", "login_timeout"
                        await self._finish(force=True)
                        return
                    continue
                if chunk is None:
                    await self._finish()
                    return
                self._feed(chunk)
                await self._scan()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = str(exc)[:200]
            await self._finish(force=True)

    async def _drain_nowait(self) -> None:
        while not self._queue.empty():
            c = self._queue.get_nowait()
            if c:
                self._feed(c)
        await self._scan()

    def _feed(self, chunk: bytes) -> None:
        text = ANSI_RE.sub("", chunk.decode(errors="replace"))
        self._partial += text.replace("\r\n", "\n").replace("\r", "\n")
        *complete, self._partial = self._partial.split("\n")
        self.lines.extend(l for l in complete if l.strip())

    # ── parsing ────────────────────────────────────────────────────────────
    async def _scan(self) -> None:
        changed = False
        if not self.url:
            for line in self.lines:
                for m in URL_RE.finditer(line):
                    u = m.group(0).rstrip(").,")
                    host = u.split("/")[2].split("@")[-1].split(":")[0].lower()
                    if host in LOGIN_HOSTS:
                        self.url, changed = u, True
                        break
                if self.url:
                    break
        if not self.code and self.account.provider == "codex":
            for i, line in enumerate(self.lines):
                if "one-time code" in line.lower():
                    for cand in self.lines[i:i + 3]:
                        m = CODE_RE.search(cand)
                        if m:
                            self.code, changed = m.group(1), True
                            break
                if self.code:
                    break
        if changed:
            log.info("login prompt account=%s after=%.1fs url=%s code=%s",
                     self.account.id, time.time() - self.started_at,
                     bool(self.url), bool(self.code))
            await self.emit("account.login.prompt", {
                "account_id": self.account.id, "provider": self.account.provider,
                "url": self.url, "url_host": (self.url.split("/")[2] if self.url else None),
                "code": self.code, "needs_code": self.needs_code,
                "expires_at": self.expires_at,
            })

    async def submit_code(self, code: str) -> None:
        # A wrong code ends the CLI's session for good, so obvious rubbish is
        # refused here rather than spent: `true` is the authorize URL's own
        # `code=true` flag, which a client can mistake for the real thing.
        head = code.strip().split("#", 1)[0]
        if len(head) < 10 or head == "true":
            log.warning("refused a code that cannot be an authorization code: %r", head[:20])
            raise Err("bad_code", "that is not the authorization code")
        log.info("code submitted account=%s length=%d has_state=%s",
                 self.account.id, len(code.strip()), "#" in code)
        """Claude asks the user to paste the authorization code."""
        if self.pty is None or self.done:
            raise Err("no_login_session", "no sign-in is in progress")
        if not self.needs_code:
            raise Err("no_code_needed", "this tool does not ask for a code")
        self.pty.write((code.strip() + "\n").encode())

    # ── finish ─────────────────────────────────────────────────────────────
    async def _finish(self, force: bool = False) -> None:
        if self.done:
            return
        self.done = True
        if force:
            self._kill()
        # refresh() shells out; keep it off the event loop.
        await asyncio.to_thread(refresh, self.account)
        self.ok = self.account.logged_in
        # The address is only a pre-fill on the sign-in form. A browser that is
        # already signed in as somebody else is never shown that form: the
        # authorize page honours the session it has and hands back a code for
        # THEM, so a second account silently became a copy of the first. The
        # CLI has just said whose sign-in this is, so it is caught here rather
        # than discovered later in the account list.
        if (self.ok and self.email and "@" in self.account.detail
                and self.account.detail.strip().lower() != self.email.strip().lower()):
            log.warning("login account mismatch account=%s asked=%s got=%s",
                        self.account.id, self.email, self.account.detail)
            self.ok = False
            self.error = f"signed in as {self.account.detail}, not {self.email}"
            self.error_code = "wrong_account"
        if self.ok:
            # a genuine sign-in on this machine: the token is ours to revoke again
            self.account.imported = False
        if not self.ok and not self.error:
            self.error = (self.lines[-1][:200] if self.lines else "")
            if not self.error:
                self.error, self.error_code = "the sign-in did not complete", "login_incomplete"
        if self.ok:
            log.info("login ok account=%s detail=%s", self.account.id, self.account.detail)
        else:
            # Without the CLI's own words a failed sign-in is undiagnosable.
            log.warning("login failed account=%s code=%s error=%s", self.account.id,
                        self.error_code, (self.error or "")[:200])
            for line in self.lines[-12:]:
                log.warning("  cli| %s", line[:200])
        await self.emit("account.login.done", {
            "account_id": self.account.id, "ok": self.ok,
            "detail": self.account.detail,
            "error": None if self.ok else self.error,
            "error_code": None if self.ok else self.error_code,
            # a failed CLI login exits for good; the app must start a fresh session
            "retryable": not self.ok,
        })
        self._close()

    def _kill(self) -> None:
        if self.pty is not None:
            self.pty.kill()

    def _close(self) -> None:
        if self.pty is not None:
            self.pty.close()
            self.pty = None

    async def cancel(self) -> None:
        self.done = True
        if self._task:
            self._task.cancel()
        self._kill()
        self._close()


# Everything here is configuration, never credentials: linking it means a second
# subscription sees the same instructions, skills and MCP servers as the first.
SHARED_CLAUDE = ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "plugins"]
SHARED_CODEX = ["config.toml", "AGENTS.md", "prompts", "skills"]


def _link_shared(provider: str, home: Path) -> None:
    src_root = Path.home() / (".claude" if provider == "claude" else ".codex")
    names = SHARED_CLAUDE if provider == "claude" else SHARED_CODEX
    for name in names:
        src, dst = src_root / name, home / name
        if src.exists() and not dst.exists():
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError:
                pass


def new_account(provider: str, label: str) -> Account:
    if provider not in ("claude", "codex"):
        raise Err("unknown_provider", "unknown tool")
    aid = f"{provider}-{secrets.token_hex(3)}"
    home = (ACCOUNTS_DIR / aid).resolve()          # absolute, no "~": the keychain
    home.mkdir(parents=True, exist_ok=True)        # item name hashes this string
    _link_shared(provider, home)
    return Account(id=aid, provider=provider, label=label or provider.capitalize(), home=str(home))


def logout(acc: Account) -> None:
    """Revoke the stored login. On macOS the OAuth token lives in the keychain
    under a per-config-dir name, so deleting the folder alone would orphan it.

    An imported sign-in shares its token with the computer it came from, so it
    is only removed locally — asking the CLI to log out could revoke the token
    for that computer as well."""
    acc.api_key = None
    if acc.imported:
        try:
            _cred_path(acc).unlink(missing_ok=True)
        except OSError:
            pass
        acc.logged_in, acc.detail, acc.plan = False, "", ""
        return
    try:
        cli = tools.find_cli(acc.provider)
        if not cli:
            return
        cmd = [cli, "auth", "logout"] if acc.provider == "claude" else [cli, "logout"]
        subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=acc.env())
    except Exception:
        pass
    acc.logged_in, acc.detail, acc.plan = False, "", ""


def delete_account_dir(acc: Account) -> None:
    """Log out first (frees the keychain item), then remove the folder."""
    if not acc.home:
        raise Err("default_account", "this computer's own account cannot be removed")
    logout(acc)
    shutil.rmtree(acc.home, ignore_errors=True)


# ── moving a sign-in between computers ────────────────────────────────────
#
# A CLI login is an OAuth refresh token in a small JSON blob, and it is not
# tied to the machine that obtained it, so moving that blob signs the CLI in
# elsewhere. This is the way out when the browser round-trip cannot be
# completed from the phone: sign in where a browser is easy, then move it.
#
# It is a MOVE, never a copy. Both CLIs use single-use refresh tokens: the
# first machine to refresh gets a new token and the other one's copy is dead
# ("your refresh token was already used"). So the source is cleared as soon as
# the destination has proved the sign-in works — sharing one login between two
# computers breaks both of them.

KEYCHAIN_SERVICE = "Claude Code-credentials"


def _cred_path(acc: Account) -> Path:
    if acc.provider == "claude":
        root = Path(acc.home) if acc.home else Path.home() / ".claude"
        return root / ".credentials.json"
    root = Path(acc.home) if acc.home else Path.home() / ".codex"
    return root / "auth.json"


def _keychain_delete() -> None:
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE],
                       capture_output=True, text=True, timeout=15)
    except Exception:
        pass


def forget_credentials(acc: Account) -> Account:
    """Drop the stored sign-in locally without telling the service. Used on the
    computer a sign-in was moved AWAY from: a real logout would revoke the token
    the destination is now using."""
    try:
        _cred_path(acc).unlink(missing_ok=True)
    except OSError:
        pass
    if acc.provider == "claude" and not acc.home:
        _keychain_delete()
    acc.logged_in, acc.detail, acc.plan = False, "", ""
    return acc


def _keychain_read() -> str | None:
    if sys.platform != "darwin":
        return None
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True, timeout=15)
        return r.stdout.strip() or None
    except Exception:
        return None


def export_credentials(acc: Account) -> dict:
    """The account's stored sign-in, as JSON. Raises if there is nothing to copy."""
    raw = None
    p = _cred_path(acc)
    if p.exists():
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError:
            raw = None
    if raw is None and acc.provider == "claude" and not acc.home:
        raw = _keychain_read()          # macOS keeps the default login here
    if not raw:
        raise Err("no_credentials", "this account has no sign-in stored on this computer")
    try:
        blob = json.loads(raw)
    except json.JSONDecodeError:
        raise Err("bad_credentials", "the stored sign-in could not be read")
    if not isinstance(blob, dict) or not blob:
        raise Err("bad_credentials", "the stored sign-in could not be read")
    blob.pop("mcpOAuth", None)          # per-server MCP tokens are not part of a login
    return blob


def import_credentials(acc: Account, blob: dict) -> Account:
    """Write a sign-in copied from another computer into this account."""
    if not acc.home:
        # The built-in account is the computer's own login. On macOS the CLI
        # reads it from the keychain, so a file written here would be ignored,
        # and `imported` is not persisted for it — a later sign-out would then
        # revoke the token for the computer it was copied from.
        raise Err("default_account", "copy the sign-in into an account you added, not this computer's own")
    if not isinstance(blob, dict) or not blob:
        raise Err("bad_credentials", "the copied sign-in is empty")
    if acc.provider == "claude" and "claudeAiOauth" not in blob:
        raise Err("wrong_provider", "that sign-in is not a Claude sign-in")
    if acc.provider == "codex" and "tokens" not in blob and "OPENAI_API_KEY" not in blob:
        raise Err("wrong_provider", "that sign-in is not a Codex sign-in")
    p = _cred_path(acc)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.unlink(missing_ok=True)
    # 0600 from creation: a crash must never leave a world-readable token behind
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(blob))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    try:
        os.replace(tmp, p)
    except PermissionError:
        # Windows refuses the swap while the CLI holds the file open
        tmp.unlink(missing_ok=True)
        raise Err("credentials_locked", "the tool is using that file — close it and try again")
    acc.imported = True
    return refresh(acc)


def check_api_key(key: str, provider: str = "claude") -> tuple[bool, str]:
    """Ask the service whether the key is real. Listing models costs nothing and
    answers in a second, where running the CLI takes a minute to time out — and
    the Codex CLI stores a key without checking it at all, so a wrong one would
    look signed in until the first message failed."""
    import urllib.error
    import urllib.request
    if provider == "claude":
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/models?limit=1",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
    else:
        req = urllib.request.Request(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return (200 <= r.status < 300), ""
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, "the service did not accept that key"
        return False, f"the service answered {e.code}"
    except Exception as exc:
        return False, str(exc)[:120]


def login_with_key(acc: Account, key: str) -> tuple[Account, bool, str]:
    """Sign in with a key. Claude reads it from the environment, so it is kept
    with the account; Codex has a command that stores it itself — and that
    command wants the key piped in, not typed at a terminal."""
    key = (key or "").strip()
    if not key:
        raise Err("key_required", "paste the key for that sign-in method")
    ok, why = check_api_key(key, acc.provider)
    if not ok:
        return refresh(acc), False, why
    if acc.provider == "claude":
        return set_api_key(acc, key), True, ""
    cli = tools.find_cli("codex")
    if not cli:
        return acc, False, "the codex CLI is not installed"
    try:
        r = subprocess.run([cli, "login", "--with-api-key"], input=key + "\n",
                           capture_output=True, text=True, timeout=60, env=acc.env())
    except Exception as exc:
        return acc, False, str(exc)[:160]
    acc = refresh(acc)
    if acc.logged_in:
        return acc, True, ""
    out = ((r.stderr or "") + (r.stdout or "")).strip()
    return acc, False, (out.splitlines()[-1][:160] if out else "the tool did not accept that key")


def set_api_key(acc: Account, key: str) -> Account:
    """Sign an account in with a key. The Claude CLI has no command for this —
    it reads the key from the environment — so it is kept with the account."""
    key = (key or "").strip()
    if not key:
        raise Err("key_required", "paste the key for that sign-in method")
    if acc.provider != "claude":
        raise Err("unknown_method", "that sign-in method is not available")
    acc.api_key = key
    return refresh(acc)


def verify_signed_in(acc: Account, timeout: int = 90) -> tuple[bool, str]:
    """Ask the CLI to actually talk to the service. `auth status` only reads a
    local file, so it reports a revoked or rotated token as a healthy login;
    only a real round-trip proves a copied sign-in works."""
    try:
        cli = tools.find_cli(acc.provider)
        if not cli:
            return False, f"the {acc.provider} CLI is not installed"
        cmd = ([cli, "-p", "Reply with the word ok.", "--output-format", "text"]
               if acc.provider == "claude" else [cli, "exec", "--skip-git-repo-check", "Reply with the word ok."])
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=acc.env())
        if r.returncode == 0:
            return True, ""
        out = ((r.stderr or "") + (r.stdout or "")).strip()
        return False, out.splitlines()[-1][:160] if out else "the tool refused the sign-in"
    except subprocess.TimeoutExpired:
        return False, "the tool did not answer in time"
    except Exception as exc:
        return False, str(exc)[:160]
