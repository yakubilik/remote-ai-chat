"""Finding and installing the `claude` and `codex` CLIs.

Two problems this solves on a fresh machine (Windows especially):

* the daemon is started by a service manager with a minimal PATH, so a CLI
  installed by npm into %APPDATA%\\npm or ~/.npm-global is invisible to it;
* the user wants to install a missing CLI from the phone.

Installs go through npm with a fixed package name. Nothing here ever downloads
a script and pipes it into a shell.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Awaitable, Callable

from .errors import Err

PACKAGES = {"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex"}
BIN_NAMES = {"claude": "claude", "codex": "codex"}
INSTALL_TIMEOUT = 15 * 60

_cache: dict[str, str] = {}


def _candidate_dirs() -> list[Path]:
    """Where a globally installed CLI can land, beyond PATH."""
    home = Path.home()
    dirs = [home / ".local" / "bin", home / "bin", home / ".npm-global" / "bin"]
    if sys.platform == "win32":
        dirs += [Path(os.environ.get("APPDATA", home)) / "npm",
                 home / "AppData" / "Roaming" / "npm"]
    else:
        dirs += [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    prefix = npm_prefix()
    if prefix:
        dirs.append(Path(prefix) / ("" if sys.platform == "win32" else "bin"))
    return dirs


def npm_prefix() -> str | None:
    npm = shutil.which("npm")
    if not npm:
        return None
    try:
        r = subprocess.run([npm, "prefix", "-g"], capture_output=True, text=True, timeout=30)
        out = (r.stdout or "").strip()
        return out or None
    except Exception:
        return None


def _candidates(provider: str) -> list[str]:
    """Every place the CLI might be, most specific first; duplicates removed."""
    name = BIN_NAMES[provider]
    out: list[str] = []
    w = shutil.which(name)
    if w:
        out.append(w)
    exts = [".cmd", ".exe", ""] if sys.platform == "win32" else [""]
    for d in _candidate_dirs():
        for ext in exts:
            p = d / (name + ext)
            if p.exists():
                out.append(str(p))
    if provider == "claude":
        b = _bundled_claude()
        if b:
            out.append(b)
    seen: set[str] = set()
    return [c for c in out if not (c.lower() in seen or seen.add(c.lower()))]


def _probe(path: str) -> str | None:
    """`<cli> --version` → first output line, or None if it does not actually run.
    On managed Windows PCs AppLocker lets an npm `claude.cmd` exist on PATH but
    refuses to execute it ("blocked by group policy"), so existence is not enough."""
    try:
        r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    line = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
    first = line[0][:60] if line else ""
    if r.returncode != 0 or not any(ch.isdigit() for ch in first):
        return None
    return first


_versions: dict[str, str] = {}


def find_cli(provider: str) -> str | None:
    """Absolute path to a CLI that runs, or None. Cached; call forget() after installing."""
    if provider in _cache and Path(_cache[provider]).exists():
        return _cache[provider]
    for cand in _candidates(provider):
        ver = _probe(cand)
        if ver:
            _cache[provider] = cand
            _versions[provider] = ver
            return cand
    return None


def _bundled_claude() -> str | None:
    """The Claude Code CLI shipped inside claude_agent_sdk. ClaudeProvider runs
    exactly this binary, so login state and version reported here match what
    chats use even when no `claude` was installed with npm."""
    try:
        import claude_agent_sdk
        p = Path(claude_agent_sdk.__file__).parent / "_bundled" / ("claude.exe" if sys.platform == "win32" else "claude")
        return str(p) if p.is_file() else None
    except Exception:
        return None


def forget(provider: str | None = None) -> None:
    if provider:
        _cache.pop(provider, None)
        _versions.pop(provider, None)
    else:
        _cache.clear()
        _versions.clear()


def version(provider: str) -> str | None:
    if not find_cli(provider):
        return None
    return _versions.get(provider)


def npm_available() -> bool:
    return shutil.which("npm") is not None


async def install(provider: str, on_output: Callable[[str], Awaitable[None]]) -> dict:
    """`npm install -g <package>`, streaming its output. Returns the new version."""
    if provider not in PACKAGES:
        raise Err("unknown_tool", "unknown tool")
    npm = shutil.which("npm")
    if not npm:
        raise Err("npm_missing", "npm was not found — install Node.js on the computer first (nodejs.org)")
    pkg = PACKAGES[provider]
    await on_output(f"$ npm install -g {pkg}\n")
    proc = await asyncio.create_subprocess_exec(
        npm, "install", "-g", pkg,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    try:
        async def pump() -> None:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                await on_output(line.decode(errors="replace"))
        await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), INSTALL_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise Err("install_timeout", "the installation timed out")
    if proc.returncode != 0:
        raise Err("install_failed", f"npm exited with code {proc.returncode}")
    forget(provider)
    ver = version(provider)
    if not ver:
        raise Err("install_no_cli", "the installation finished but the command was not found — check PATH")
    await on_output(f"\n{provider} {ver}\n")
    return {"provider": provider, "version": ver, "path": find_cli(provider)}
