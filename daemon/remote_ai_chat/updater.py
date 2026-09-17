"""Keeping every computer on the same commit.

Two machines run this daemon: the Mac it is written on and a Windows laptop.
Neither updates the other. Both follow `origin/main`, which is the only thing
either of them trusts — a machine that pushed to another would have to be
believed, and there would be no answer to "which one is right" the day they
disagree. Following a common source makes drifting apart impossible instead of
merely unlikely.

Both installs are `pip install -e`, so a pull *is* the update: the code on disk
is the code that runs. Dependencies are the exception, and only when
`pyproject.toml` actually changed.

Restarting is somebody else's job already. macOS has launchd with
`KeepAlive=true` and Windows has `start.ps1`, and both bring the daemon back
within seconds of it exiting. So the update ends by asking the server to stop,
and the machine's own supervisor starts it again on the new code.

What this will not do:

* touch a repository with uncommitted work in it — that is the development
  machine, mid-thought, and pulling the floor out from under it would be the
  one unforgivable bug here;
* do anything but a fast-forward, so a local commit is never silently dropped;
* interrupt a running turn;
* wait on a credential prompt (a private repo with no cached credentials would
  otherwise hang the fetch forever, invisibly).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("rac.updater")

# How long a git call may take before it is assumed wedged. A fetch over a
# sleepy tailnet is slow; it is not, however, minutes slow.
GIT_TIMEOUT_S = 90


def repo_root() -> Path | None:
    """The working copy this daemon is running from, if it is running from one.

    An editable install leaves the package inside the repository, so walking up
    from this file finds it. A copied install has no `.git` and simply never
    updates — correctly, because there would be nothing to pull into.
    """
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    return None


async def _git(root: Path, *args: str, timeout: int = GIT_TIMEOUT_S) -> tuple[int, str]:
    """Run git, never interactively.

    `GIT_TERMINAL_PROMPT=0` and the two ssh options below turn "ask for a
    password" into "fail immediately". Against a private repo on a machine whose
    credentials have expired, the alternative is a subprocess that waits for a
    human who is not there, holding the update loop open until the daemon
    restarts.
    """
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "GCM_INTERACTIVE": "never",
        "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
    }
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=str(root), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        return 127, "git not installed"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return 124, f"git {args[0]} timed out after {timeout}s"
    return proc.returncode or 0, (out or b"").decode("utf-8", "replace").strip()


async def revision(root: Path | None = None) -> dict:
    """What this computer is actually running.

    The package version is a constant that nobody remembers to raise — both
    machines called themselves 0.1.0 while one was weeks ahead of the other, so
    the number they agreed on was the one thing that could not tell them apart.
    The commit can.
    """
    root = root or repo_root()
    if root is None:
        return {"repo": False}
    rc, out = await _git(root, "log", "-1", "--format=%h%x00%H%x00%cI%x00%s")
    if rc != 0:
        return {"repo": False, "error": out[:200]}
    short, full, when, subject = (out.split("\0") + ["", "", "", ""])[:4]
    _, branch = await _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    _, dirty = await _git(root, "status", "--porcelain")
    return {
        "repo": True, "commit": short, "sha": full, "committed_at": when,
        "subject": subject[:120], "branch": branch,
        "dirty": bool(dirty.strip()),
        "dirty_files": len([l for l in dirty.splitlines() if l.strip()]),
    }


class Updater:
    """Watches `origin/main` and, when allowed, moves this computer onto it."""

    def __init__(self, cfg, is_idle: Callable[[], bool],
                 announce: Callable[[dict], Awaitable[None]],
                 request_restart: Callable[[], None]):
        self.cfg = cfg
        self.is_idle = is_idle
        self.announce = announce
        self.request_restart = request_restart
        self.root = repo_root()
        self.state: dict = {
            "repo": self.root is not None,
            "auto": bool(getattr(cfg, "auto_update", True)),
            "behind": 0, "ahead": 0, "checked_at": None,
            "busy": False, "error": None, "local": None, "remote": None,
        }
        self._lock = asyncio.Lock()

    # ── reading the world ──────────────────────────────────────────────────
    async def check(self) -> dict:
        """Ask the remote where it is. Cheap, read-only, safe at any moment."""
        if self.root is None:
            self.state["error"] = "not a git checkout"
            return self.state
        async with self._lock:
            rc, out = await _git(self.root, "fetch", "--quiet", "origin", "main")
            if rc != 0:
                # An unreachable remote is the normal state of a laptop, not an
                # incident. It is recorded and the loop tries again later.
                self.state["error"] = out[:200] or f"git fetch exited {rc}"
                self.state["checked_at"] = time.time()
                return self.state
            self.state["error"] = None
            self.state["local"] = await revision(self.root)
            rc, counts = await _git(self.root, "rev-list", "--left-right", "--count",
                                    "origin/main...HEAD")
            behind = ahead = 0
            if rc == 0 and counts:
                parts = counts.split()
                if len(parts) == 2:
                    behind, ahead = int(parts[0]), int(parts[1])
            rc, head = await _git(self.root, "log", "-1", "--format=%h%x00%cI%x00%s",
                                  "origin/main")
            if rc == 0:
                c, when, subject = (head.split("\0") + ["", "", ""])[:3]
                self.state["remote"] = {"commit": c, "committed_at": when,
                                        "subject": subject[:120]}
            self.state["behind"] = behind
            self.state["ahead"] = ahead
            self.state["checked_at"] = time.time()
            return self.state

    def blockers(self) -> list[str]:
        """Why an update cannot run right now, in words a phone can show."""
        out: list[str] = []
        if self.root is None:
            out.append("not a git checkout")
            return out
        if self.state.get("behind", 0) <= 0:
            out.append("already up to date")
        if (self.state.get("local") or {}).get("dirty"):
            out.append("uncommitted changes")
        if self.state.get("ahead", 0) > 0:
            out.append("unpushed commits")
        if not self.is_idle():
            out.append("a turn is running")
        return out

    # ── changing the world ─────────────────────────────────────────────────
    async def apply(self, force: bool = False) -> dict:
        """Fast-forward onto `origin/main` and hand over to the supervisor.

        `force` waives only *waiting* — being behind, and being idle. It never
        waives a dirty tree or unpushed commits, because those are somebody's
        work and this function is not entitled to decide they are expendable.
        """
        if self.root is None:
            return {"ok": False, "error": "not a git checkout"}
        if self.state.get("checked_at") is None:
            await self.check()

        local = self.state.get("local") or await revision(self.root)
        if local.get("dirty"):
            return {"ok": False, "error": "uncommitted changes — refusing to touch this checkout"}
        if self.state.get("ahead", 0) > 0:
            return {"ok": False, "error": "this checkout has commits that were never pushed"}
        if not force:
            if self.state.get("behind", 0) <= 0:
                return {"ok": False, "error": "already up to date"}
            if not self.is_idle():
                return {"ok": False, "error": "a turn is running"}

        async with self._lock:
            self.state["busy"] = True
            try:
                before = (await revision(self.root)).get("sha")
                # Only ever a fast-forward: if the histories have diverged the
                # pull fails and the machine stays where it is, which is the
                # right outcome — a merge here would be a robot's guess at what
                # somebody meant.
                rc, out = await _git(self.root, "merge", "--ff-only", "origin/main")
                if rc != 0:
                    return {"ok": False, "error": f"fast-forward failed: {out[:300]}"}
                after = await revision(self.root)
                log.info("updated %s -> %s", (before or "")[:8], after.get("commit"))

                if await self._deps_changed(before, after.get("sha")):
                    ok, detail = await self._install_deps()
                    if not ok:
                        await self._rollback(before)
                        return {"ok": False, "error": f"dependency install failed: {detail}"}

                ok, detail = await self._smoke()
                if not ok:
                    await self._rollback(before)
                    return {"ok": False, "error": f"new code failed to import: {detail}"}

                self.state["local"] = after
                self.state["behind"] = 0
                await self.announce({"event": "update.applied", "revision": after})
                # Everything past this point runs on the old code, so there is
                # nothing left worth doing here. The supervisor restarts us.
                self.request_restart()
                return {"ok": True, "revision": after, "restarting": True}
            finally:
                self.state["busy"] = False

    async def _deps_changed(self, before: str | None, after: str | None) -> bool:
        if not before or not after or before == after:
            return False
        rc, out = await _git(self.root, "diff", "--name-only", before, after,
                             "--", "daemon/pyproject.toml")
        return rc == 0 and bool(out.strip())

    async def _install_deps(self) -> tuple[bool, str]:
        """Re-install into the venv this daemon is running from."""
        daemon_dir = str(self.root / "daemon")
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "pip", "install", "--quiet", "-e", daemon_dir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
        except Exception as exc:
            return False, str(exc)[:300]
        text = (out or b"").decode("utf-8", "replace").strip()
        return (proc.returncode == 0), text[-300:]

    async def _smoke(self) -> tuple[bool, str]:
        """Import the freshly pulled package in a separate process.

        A syntax error in the new code would otherwise only be discovered after
        the restart — by a supervisor dutifully restarting a daemon that cannot
        start, forever, on a machine nobody is sitting at.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c",
                # `server` pulls in everything that matters, this module
                # included. Naming modules individually would make the check
                # fail the day one of them is renamed — which is exactly the
                # kind of change worth shipping.
                "import remote_ai_chat, remote_ai_chat.server",
                cwd=str(self.root / "daemon"),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        except Exception as exc:
            return False, str(exc)[:300]
        text = (out or b"").decode("utf-8", "replace").strip()
        return (proc.returncode == 0), text[-300:]

    async def _rollback(self, sha: str | None) -> None:
        if not sha:
            return
        rc, out = await _git(self.root, "reset", "--hard", sha)
        log.warning("rolled back to %s (%s)", sha[:8], "ok" if rc == 0 else out[:200])

    # ── the loop ───────────────────────────────────────────────────────────
    async def loop(self) -> None:
        if self.root is None:
            log.info("updater: not a git checkout, staying put")
            return
        # Read where we are straight away, so the phone can show a commit
        # rather than a blank the moment it connects.
        self.state["local"] = await revision(self.root)
        interval = max(120, int(getattr(self.cfg, "update_interval_s", 900)))
        # Not the fetch, though: a daemon that just restarted may well be a daemon
        # this loop restarted, and a crash loop should not be able to turn into
        # a pull loop.
        await asyncio.sleep(60)
        while True:
            try:
                await self.check()
                behind = self.state.get("behind", 0)
                if behind > 0:
                    await self.announce({"event": "update.available", **self.state})
                    if self.state["auto"]:
                        blocked = self.blockers()
                        if blocked:
                            log.info("update available (%d behind) but held: %s",
                                     behind, ", ".join(blocked))
                        else:
                            log.info("update available (%d behind) — applying", behind)
                            res = await self.apply()
                            if not res.get("ok"):
                                log.warning("update failed: %s", res.get("error"))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("updater: %s", exc)
            await asyncio.sleep(interval)
