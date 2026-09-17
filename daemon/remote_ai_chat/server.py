"""FastAPI + WebSocket server. One JSON protocol, see docs/PROTOCOL.md."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from . import __version__
from .updater import Updater
from .config import Config, DB_PATH, UPLOAD_DIR, Device
from .db import DB
from . import accounts as acct
from .errors import Err
from . import agents, tools
from .call import Concierge, headline as call_headline, snapshot as call_snapshot
from .push import send_push
from .transcribe import transcribe, available as transcribe_available
from .security import PathPolicy
from .session import NEW_CHAT_TITLE, PROVIDER_FIELDS, PROVIDERS, SessionManager
from .providers.codex import live_models as codex_live_models

log = logging.getLogger("rac.server")

KINDS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image",
    ".mp4": "video", ".mov": "video", ".m4v": "video",
    ".m4a": "audio", ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".caf": "audio", ".aac": "audio",
    ".pdf": "file", ".txt": "file", ".md": "file", ".json": "file", ".csv": "file", ".log": "file",
}

PUSH_TEXT = {
    "en": {"approval": "Approval pending", "done": "Task finished"},
    "tr": {"approval": "Onay bekliyor", "done": "İş tamamlandı"},
}


# ── git status (for the panel) ───────────────────────────────────────────────
# The panel's project grid shows a branch, a dirty count and a last commit for
# every folder. `host.projects` does not carry that: the phone's folder picker
# would have to wait on 60 git calls for 19 folders. It is a separate request
# instead, answered from a thread pool behind a short-lived cache.
_GIT_TTL = 20.0
_git_cache: dict[str, tuple[float, dict]] = {}


def _git_info(path: str) -> dict:
    now = time.time()
    hit = _git_cache.get(path)
    if hit and now - hit[0] < _GIT_TTL:
        return hit[1]

    def run(*args: str) -> str | None:
        try:
            r = subprocess.run(("git", "-C", path, *args), capture_output=True,
                               text=True, timeout=3)
        except Exception:
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    inside = run("rev-parse", "--is-inside-work-tree")
    if inside != "true":
        info = {"is_git": False}
    else:
        status = run("status", "--porcelain") or ""
        dirty = [ln for ln in status.splitlines() if ln.strip()]
        last = run("log", "-1", "--format=%s%x1f%an%x1f%ct")
        subject = author = None
        committed = None
        if last:
            bits = last.split("\x1f")
            subject = bits[0] if bits else None
            author = bits[1] if len(bits) > 1 else None
            try:
                committed = float(bits[2]) if len(bits) > 2 else None
            except ValueError:
                committed = None
        info = {
            "is_git": True,
            "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": len(dirty),
            "staged": sum(1 for ln in dirty if ln[:1] not in (" ", "?")),
            "untracked": sum(1 for ln in dirty if ln.startswith("??")),
            "subject": subject,
            "author": author,
            "committed_at": committed,
        }
    _git_cache[path] = (now, info)
    return info


class Server:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db = DB(DB_PATH)
        self.policy = PathPolicy(cfg.allowed_roots, cfg.denied_paths)
        self.sessions = SessionManager(self.db, cfg, self.broadcast, self.notify,
                                       resolve_account=self._resolve_account_home,
                                       agent_prompt=self._agent_prompt)
        self.clients: dict[WebSocket, Device] = {}
        self.accounts: dict[str, acct.Account] = {}
        self.logins: dict[str, acct.LoginSession] = {}
        self._installing: str | None = None
        # account id -> window -> last reported usage of the plan's limits,
        # reloaded from disk so a restart does not blank the ring out.
        self.limits: dict[str, dict[str, dict]] = self.db.load_limits()
        # Every computer follows origin/main on its own. Set when an update has
        # been staged and the supervisor should take it from here.
        self.restart_requested = asyncio.Event()
        self.updater = Updater(
            cfg,
            is_idle=lambda: self.sessions.active_count() == 0,
            announce=self._announce_update,
            request_restart=self.restart_requested.set,
        )
        self._load_accounts()
        self.failed_auth: dict[str, list[float]] = {}
        self.started = time.time()
        self.app = FastAPI(title="remote-ai-chat")
        self.app.websocket("/ws")(self.ws_endpoint)
        self.app.get("/health")(lambda: {"ok": True, "version": __version__})
        self.app.post("/upload")(self.upload)
        self.app.get("/files")(self.files)
        self._mount_panel()
        self._versions: dict | None = None
        self._codex_models: list[dict] | None = None
        self._codex_models_task: asyncio.Task | None = None
        # The voice concierge. Built here but not connected — the CLI only
        # starts when somebody actually asks it something.
        self.concierge = Concierge(self.call_snapshot, self._concierge_account,
                                   self._concierge_actions())

    def _mount_panel(self) -> None:
        """Serve the desktop panel, when it has been built.

        Mounted last and at "/", so /ws, /health, /upload and /files still win —
        FastAPI matches routes in registration order. The bundle itself holds no
        secret: it asks for a token like any other client, so handing it to
        anyone who can reach the port costs nothing.
        """
        panel = Path(__file__).parent / "webui"
        if not (panel / "index.html").exists():
            return
        from fastapi.staticfiles import StaticFiles
        self.app.mount("/", StaticFiles(directory=str(panel), html=True), name="panel")

    # ── tools (CLI kurulumu) ───────────────────────────────────────────────
    async def h_tool_status(self, dev: Device, d: dict) -> dict:
        tools.forget()
        return {"tools": [{"provider": p, "version": tools.version(p),
                           "path": tools.find_cli(p),
                           "login_methods": acct.methods_for(p)} for p in ("claude", "codex")],
                "npm": tools.npm_available()}

    async def h_tool_install(self, dev: Device, d: dict, ws: WebSocket) -> dict:
        provider = d.get("provider", "")
        if provider not in tools.PACKAGES:
            raise Err("unknown_tool", "unknown tool")
        if self._installing:
            raise Err("install_running", "an installation is already running")
        if tools.find_cli(provider) and not d.get("force"):
            return {"provider": provider, "version": tools.version(provider), "already": True}

        async def out(line: str) -> None:
            try:
                await ws.send_text(json.dumps({"type": "event", "event": "tool.install.output",
                                               "chat_id": None, "seq": None,
                                               "data": {"provider": provider, "line": line},
                                               "ts": time.time()}, ensure_ascii=False))
            except Exception:
                pass

        self._installing = provider
        try:
            res = await tools.install(provider, out)
        except Exception as exc:
            await out(f"\n{exc}\n")
            raise
        finally:
            self._installing = None
        self._versions = None                      # host.info reports the new version
        await self.broadcast({"seq": None, "chat_id": None, "event": "host.status",
                              "data": self.host_info(), "ts": time.time()})
        return res

    # ── accounts ───────────────────────────────────────────────────────────
    def _load_accounts(self) -> None:
        self.accounts = {a.id: a for a in acct.default_accounts()}
        for aid, raw in (self.cfg.accounts or {}).items():
            try:
                self.accounts[aid] = acct.Account(id=aid, **raw)
            except Exception as exc:
                log.warning("skipping stored account %s: %s", aid, exc)

    def _save_accounts(self) -> None:
        # TOML has no null: a field without a value is left out, not written.
        self.cfg.accounts = {
            a.id: {k: v for k, v in
                   {"provider": a.provider, "label": a.label, "home": a.home,
                    "created_at": a.created_at, "imported": a.imported,
                    "api_key": a.api_key}.items() if v is not None}
            for a in self.accounts.values() if a.home
        }
        self.cfg.save()

    def _agent_prompt(self, chat: dict) -> str | None:
        aid = chat.get("agent_id")
        if not aid:
            return None
        home = self._account(chat.get("account_id"), chat["provider"]).home
        if aid == agents.CREATOR_ID:
            return agents.builtin(home)["prompt"]
        a = agents.find(aid, home, chat.get("cwd"))
        return agents.body(a["path"]) if a else None

    async def h_agent_list(self, dev: Device, d: dict) -> dict:
        home = self._account(d.get("account_id"), d.get("provider", "claude")).home
        cwd = d.get("cwd") or None
        items = await asyncio.to_thread(agents.listing, home, cwd)
        return {"agents": items}

    async def h_agent_store(self, dev: Device, d: dict) -> dict:
        items = await asyncio.to_thread(agents.store, str(d.get("source") or ""))
        return {"sources": items}

    async def h_agent_install(self, dev: Device, d: dict) -> dict:
        home = self._account(d.get("account_id"), d.get("provider", "claude")).home
        r = await asyncio.to_thread(agents.install, str(d.get("id") or ""), home)
        log.warning("agent installed: %s from %s by %s", r["name"], r["source"], dev.name)
        return r

    async def h_agent_remove(self, dev: Device, d: dict) -> dict:
        home = self._account(d.get("account_id"), d.get("provider", "claude")).home
        ok = await asyncio.to_thread(agents.uninstall, str(d.get("name") or ""), home)
        if not ok:
            raise Err("agent_not_removable", "that agent is not one this app installed")
        return {"removed": True}

    def _resolve_account_home(self, chat: dict) -> tuple[str | None, dict[str, str]]:
        """Where the account keeps its login, and the environment that carries
        it — an account signed in with a key has nothing on disk to point at."""
        a = self._account(chat.get("account_id"), chat["provider"])
        return a.home, a.env()

    def _account(self, account_id: str | None, provider: str) -> acct.Account:
        """Resolve a chat's account. A missing id is refused rather than falling
        back to the machine login — silently using the wrong subscription is the
        exact failure this feature exists to prevent."""
        if not account_id:
            return self.accounts[acct.DEFAULT_ID + "-" + provider]
        a = self.accounts.get(account_id)
        if a is None:
            raise Err("account_gone", "that account was removed")
        if a.provider != provider:
            raise Err("account_provider", "that account belongs to a different tool")
        return a

    # ── fan-out ────────────────────────────────────────────────────────────
    def _remember_limits(self, event: dict) -> None:
        """Keep the last word on every plan window, on disk as well as in
        memory. A report only arrives while a turn is running, so what was
        remembered is all there is to show between turns — and after a restart
        it is all there is to show at all, until someone sends a message."""
        d = event.get("data") or {}
        chat = self.db.get_chat(event.get("chat_id") or "") or {}
        key = chat.get("account_id") or acct.DEFAULT_ID + "-" + (chat.get("provider") or "claude")
        rows = d.get("windows")
        if not isinstance(rows, list) or not rows:
            # A provider that reports a single window, or a report from before
            # the daemon learned to read them all.
            rows = [{k: d.get(k) for k in ("window", "status", "utilization", "resets_at")}] \
                if d.get("window") else []
        now = time.time()
        # Overage is a property of the account, not of any one window, so every
        # row carries it and the app can read it off whichever row it shows.
        shared = {k: d.get(k) for k in
                  ("overage_status", "overage_resets_at", "overage_disabled_reason", "is_using_overage")
                  if d.get(k) is not None}
        kept = [{**shared, **r, "at": now} for r in rows if isinstance(r, dict) and r.get("window")]
        if not kept:
            return
        slot = self.limits.setdefault(key, {})
        for r in kept:
            slot[str(r["window"])] = r
        try:
            self.db.save_limits(key, kept, now)
        except Exception as e:
            log.warning("could not write down the plan's limits: %s", e)

    def limits_for(self, account_id: str | None, provider: str = "claude") -> list[dict]:
        key = account_id or acct.DEFAULT_ID + "-" + provider
        return sorted(self.limits.get(key, {}).values(), key=lambda x: str(x.get("window")))

    async def h_limits_get(self, dev: Device, d: dict) -> dict:
        return {"accounts": {k: sorted(v.values(), key=lambda x: str(x.get("window")))
                             for k, v in self.limits.items()}}

    async def _announce_update(self, data: dict) -> None:
        await self.broadcast({"seq": None, "chat_id": None,
                              "event": data.pop("event", "update.available"),
                              "data": data, "ts": time.time()})

    async def h_update_status(self, dev: Device, d: dict) -> dict:
        """Where this computer stands. `refresh` asks the remote, which costs a
        network round trip, so the phone only does it when someone is looking."""
        if d.get("refresh"):
            await self.updater.check()
        return {**self.updater.state, "blockers": self.updater.blockers()}

    async def h_update_apply(self, dev: Device, d: dict) -> dict:
        """Move onto origin/main now. Answers before the restart lands, because
        after it there is no connection left to answer on."""
        await self.updater.check()
        return await self.updater.apply(force=bool(d.get("force")))

    async def broadcast(self, event: dict) -> None:
        if event.get("event") == "limits":
            self._remember_limits(event)
        msg = json.dumps({"type": "event", "event": event["event"], "chat_id": event.get("chat_id"),
                          "seq": event.get("seq"), "data": event.get("data"), "ts": event.get("ts")},
                         ensure_ascii=False, default=str)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)

    async def notify(self, kind: str, chat: dict) -> None:
        title = chat.get("title", "Chat")
        for d in self.cfg.devices.values():
            if not d.push_token:
                continue
            if kind == "approval" and d.push_approval:
                body = PUSH_TEXT.get(d.lang, PUSH_TEXT["en"])["approval"]
            elif kind == "done" and d.push_done:
                # Sent to connected phones too. A phone that is looking at this
                # very chat silences it itself — the computer cannot know what
                # is on screen, and staying silent for every open app meant the
                # notification never arrived at all.
                body = PUSH_TEXT.get(d.lang, PUSH_TEXT["en"])["done"]
            else:
                continue
            await send_push([d.push_token], title, body, {"chat_id": chat.get("id"), "kind": kind})

    # ── uploads (attachments) ──────────────────────────────────────────────
    async def upload(self, file: UploadFile = File(...), chat_id: str = Form(""), authorization: str = Header(default="")) -> dict:
        token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        dev = self.cfg.find_device_by_token(token) if token else None
        if dev is None:
            raise HTTPException(status_code=401, detail="unauthorized")
        safe_chat = "".join(c for c in (chat_id or "misc") if c.isalnum())[:32] or "misc"
        name = Path(file.filename or "file").name
        stem = "".join(c for c in Path(name).stem if c.isalnum() or c in "-_")[:40] or "file"
        ext = Path(name).suffix.lower()[:8]
        kind = KINDS.get(ext)
        if kind is None:
            raise HTTPException(status_code=415, detail="unsupported file type")
        target_dir = UPLOAD_DIR / safe_chat
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{int(time.time())}-{stem}{ext}"
        data = await file.read()
        if len(data) > 100 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="file too large (100MB)")
        target.write_bytes(data)
        if kind == "image":
            target = _normalize_image(target)
        out = {"path": str(target), "name": target.name, "size": target.stat().st_size, "kind": kind,
               "url": f"/files?path={target}"}
        if kind == "audio":
            t = await transcribe(target, dev.lang)
            if t:
                out["transcript"] = t["text"]
        return out

    async def files(self, path: str = Query(...), authorization: str = Header(default=""), token: str = Query(default="")) -> FileResponse:
        """Serve an uploaded file back to the phone (images/videos/audio in bubbles)."""
        tok = authorization[7:].strip() if authorization.lower().startswith("bearer ") else token
        if not tok or self.cfg.find_device_by_token(tok) is None:
            raise HTTPException(status_code=401, detail="unauthorized")
        p = Path(path).resolve()
        if UPLOAD_DIR.resolve() not in p.parents or not p.is_file():
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(str(p))

    # ── auth ───────────────────────────────────────────────────────────────
    def _rate_limited(self, ip: str) -> bool:
        now = time.time()
        hist = [t for t in self.failed_auth.get(ip, []) if now - t < 600]
        self.failed_auth[ip] = hist
        return len(hist) >= 5

    def _auth(self, ws: WebSocket) -> Device | None:
        ip = ws.client.host if ws.client else "?"
        token = ws.query_params.get("token") or ""
        auth = ws.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        dev = self.cfg.find_device_by_token(token) if token else None
        if dev is not None:
            return dev  # a valid token is never locked out; the limiter only slows guessing
        if not self._rate_limited(ip):
            self.failed_auth.setdefault(ip, []).append(time.time())
        return None

    # ── websocket ──────────────────────────────────────────────────────────
    async def ws_endpoint(self, ws: WebSocket) -> None:
        dev = self._auth(ws)
        # Accept first so the client receives a real close frame (4401) instead of HTTP 403.
        await ws.accept()
        if dev is None:
            await ws.close(code=4401, reason="unauthorized")
            return
        self.clients[ws] = dev
        dev.last_seen = time.time()
        log.info("device connected: %s (%s)", dev.name, dev.id)
        await ws.send_text(json.dumps({"type": "event", "event": "host.status", "chat_id": None,
                                       "seq": None, "data": self.host_info(), "ts": time.time()}))
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    req = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                asyncio.create_task(self._dispatch(ws, dev, req))
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.warning("ws loop error: %s", exc)
        finally:
            self.clients.pop(ws, None)
            log.info("device disconnected: %s", dev.name)

    async def _dispatch(self, ws: WebSocket, dev: Device, req: dict) -> None:
        rid = req.get("id")
        typ = req.get("type", "")
        data = req.get("data") or {}
        handler = getattr(self, "h_" + typ.replace(".", "_"), None)
        try:
            if handler is None:
                raise ValueError(f"unknown type: {typ}")
            if "ws" in inspect.signature(handler).parameters:
                result = await handler(dev, data, ws)
            else:
                result = await handler(dev, data)
            out = {"id": rid, "type": "ok", "data": result}
        except Exception as exc:
            log.warning("%s failed: %s", typ, exc)
            out = {"id": rid, "type": "error",
                   "data": {"message": str(exc), "code": getattr(exc, "code", None)}}
        try:
            await ws.send_text(json.dumps(out, ensure_ascii=False, default=str))
        except Exception:
            pass

    # ── handlers ───────────────────────────────────────────────────────────
    async def h_ping(self, dev: Device, d: dict) -> dict:
        """The phone's heartbeat. A protocol-level ping only proves the socket is
        open somewhere in the OS; this proves the app is on the other end and the
        event loop is still serving it, which is what the phone needs to know
        before it decides a quiet connection is a dead one."""
        dev.last_seen = time.time()
        return {"ts": time.time()}

    async def h_hello(self, dev: Device, d: dict) -> dict:
        if d.get("push_token"):
            dev.push_token = d["push_token"]
        if d.get("device_name"):
            dev.name = d["device_name"]
        if d.get("lang") in ("en", "tr"):
            dev.lang = d["lang"]
        self.cfg.save()
        return {"host": self.host_info(), "catalog": await self.catalog_async(),
                "device": {"id": dev.id, "name": dev.name, "push_approval": dev.push_approval,
                           "push_done": dev.push_done, "has_push_token": bool(dev.push_token)}}

    async def h_host_info(self, dev: Device, d: dict) -> dict:
        return self.host_info()

    async def h_device_prefs(self, dev: Device, d: dict) -> dict:
        if "push_approval" in d:
            dev.push_approval = bool(d["push_approval"])
        if "push_done" in d:
            dev.push_done = bool(d["push_done"])
        if "push_token" in d:
            dev.push_token = d["push_token"] or None
        if d.get("lang") in ("en", "tr"):
            dev.lang = d["lang"]
        self.cfg.save()
        return {"push_approval": dev.push_approval, "push_done": dev.push_done, "has_push_token": bool(dev.push_token)}

    async def h_device_revoke_self(self, dev: Device, d: dict) -> dict:
        self.cfg.revoke(dev.id)
        return {}

    async def h_host_models(self, dev: Device, d: dict) -> dict:
        return await self.catalog_async()

    async def h_host_projects(self, dev: Device, d: dict) -> dict:
        return {"projects": self.policy.list_projects(), "roots": self.cfg.allowed_roots}

    async def h_host_git(self, dev: Device, d: dict) -> dict:
        """Git state for the panel's project grid. Read-only, and only for
        folders the path policy already allows a chat to run in."""
        paths = [str(p) for p in (d.get("paths") or [])][:80]
        if not paths:
            paths = [p["path"] for p in self.policy.list_projects()]
        allowed = [p for p in paths if self.policy.is_allowed_cwd(p)]
        results = await asyncio.gather(
            *(asyncio.to_thread(_git_info, p) for p in allowed),
            return_exceptions=True,
        )
        repos = {p: r for p, r in zip(allowed, results) if isinstance(r, dict)}
        return {"repos": repos}

    async def h_group_list(self, dev: Device, d: dict) -> dict:
        return {"groups": self.db.list_groups()}

    async def _groups_changed(self) -> None:
        await self.broadcast({"seq": None, "chat_id": None, "event": "groups.changed",
                              "data": {"groups": self.db.list_groups()}, "ts": time.time()})

    async def h_group_create(self, dev: Device, d: dict) -> dict:
        g = self.db.create_group(str(d.get("name") or "Group").strip()[:60])
        await self._groups_changed()
        return g

    async def h_group_rename(self, dev: Device, d: dict) -> dict:
        self.db.rename_group(d["group_id"], str(d["name"]).strip()[:60])
        await self._groups_changed()
        return {}

    async def h_group_delete(self, dev: Device, d: dict) -> dict:
        self.db.delete_group(d["group_id"])
        await self._groups_changed()
        await self.broadcast({"seq": None, "chat_id": None, "event": "chats.changed",
                              "data": {"chats": self.db.list_chats(True)}, "ts": time.time()})
        return {}

    async def h_chat_list(self, dev: Device, d: dict) -> dict:
        return {"chats": self.db.list_chats(bool(d.get("include_archived"))),
                "groups": self.db.list_groups()}

    async def h_chat_create(self, dev: Device, d: dict) -> dict:
        provider = d.get("provider", "claude")
        if provider not in PROVIDERS:
            raise Err("unknown_provider", "unknown tool")
        cwd = d.get("cwd") or self.cfg.allowed_roots[0]
        if not self.policy.is_allowed_cwd(cwd):
            raise Err("cwd_outside", "folder is outside the allowed roots")
        cat = PROVIDERS[provider].catalog()
        model = d.get("model") or cat["models"][0]["id"]
        effort = d.get("effort") or ("high" if cat["efforts"] else None)
        perm = d.get("perm_mode") or cat["perm_modes"][0]
        if perm not in cat["perm_modes"]:
            raise Err("unknown_perm_mode", "unknown permission mode")
        account_id = d.get("account_id")
        self._account(account_id, provider)          # raises if unknown/mismatched
        agent_id = d.get("agent_id") or None
        if agent_id and agent_id != agents.CREATOR_ID \
                and not agents.find(agent_id, self._account(account_id, provider).home, cwd):
            raise Err("no_agent", "that agent is not on this computer")
        chat = self.db.create_chat(
            account_id=account_id, agent_id=agent_id,
            provider=provider, model=model, effort=effort, perm_mode=perm,
            cwd=str(Path(cwd).expanduser().resolve()), group_id=d.get("group_id"),
            title=(d.get("title") or NEW_CHAT_TITLE)[:60],
            max_turns=d.get("max_turns"), max_budget_usd=d.get("max_budget_usd"),
        )
        await self.broadcast({"seq": None, "chat_id": chat["id"], "event": "chat.created",
                              "data": chat, "ts": time.time()})
        return chat

    async def h_chat_get(self, dev: Device, d: dict) -> dict:
        chat = self.db.get_chat(d["chat_id"])
        if chat is None:
            raise Err("no_chat", "no such chat")
        since = int(d.get("since_seq") or 0)
        events = self.db.events(chat["id"], since_seq=since, limit=int(d.get("limit") or 500))
        pending = []
        s = self.sessions.peek(chat["id"])
        if s:
            pending = list(s.pending.keys())
        return {"chat": chat, "events": events, "pending_approvals": pending,
                "busy": bool(s and s.is_busy())}

    async def h_chat_update(self, dev: Device, d: dict) -> dict:
        cid = d["chat_id"]
        fields = {k: v for k, v in d.items() if k != "chat_id"}
        if "cwd" in fields:
            if not self.policy.is_allowed_cwd(fields["cwd"]):
                raise Err("cwd_outside", "folder is outside the allowed roots")
            # Same canonical form as chat.create (case/slash-insensitive on Windows).
            fields["cwd"] = str(Path(fields["cwd"]).expanduser().resolve())
        if "account_id" in fields:
            current = self.db.get_chat(cid)
            self._account(fields["account_id"], (current or {}).get("provider", "claude"))
            # a resume id belongs to one account's transcript store
            fields["provider_session_id"] = None
        prev = self.db.get_chat(cid)
        if prev is None:
            raise Err("no_chat", "no such chat")
        if "provider" in fields and fields["provider"] != prev["provider"]:
            if fields["provider"] not in PROVIDERS:
                raise Err("unknown_provider", "unknown tool")
            # Each tool keeps its own session; remember the old one and restore the new one's.
            ids = json.loads(prev.get("session_ids") or "{}")
            if prev.get("provider_session_id"):
                ids[prev["provider"]] = prev["provider_session_id"]
            fields["provider_session_id"] = ids.get(fields["provider"])
            fields["session_ids"] = json.dumps(ids)
        chat = self.db.update_chat(cid, **fields)
        s = self.sessions.peek(cid)
        if s and PROVIDER_FIELDS & fields.keys():
            await s.reconfigure()
        await self.broadcast({"seq": None, "chat_id": cid, "event": "chat.updated",
                              "data": chat, "ts": time.time()})
        return chat

    async def h_chat_delete(self, dev: Device, d: dict) -> dict:
        cid = d["chat_id"]
        await self.sessions.drop(cid)
        self.db.delete_chat(cid)
        shutil.rmtree(UPLOAD_DIR / "".join(c for c in cid if c.isalnum())[:32], ignore_errors=True)
        await self.broadcast({"seq": None, "chat_id": cid, "event": "chat.deleted",
                              "data": {"id": cid}, "ts": time.time()})
        return {}

    async def h_chat_send(self, dev: Device, d: dict) -> dict:
        text = str(d.get("text") or "").strip()
        if not text:
            raise Err("empty_message", "empty message")
        s = self.sessions.get(d["chat_id"])
        queued = await s.send(text, d.get("attachments"))
        return {"accepted": True, "queued": queued}

    async def h_chat_interrupt(self, dev: Device, d: dict) -> dict:
        s = self.sessions.peek(d["chat_id"])
        if s:
            await s.interrupt()
        return {}

    async def h_approval_respond(self, dev: Device, d: dict) -> dict:
        s = self.sessions.peek(d["chat_id"])
        ok = bool(s and s.respond(d["request_id"], d.get("decision", "deny")))
        if not ok:
            raise Err("no_pending_approval", "no pending approval")
        return {}

    # ── the call ───────────────────────────────────────────────────────────
    # A phone call is a different shape of question than a chat. Nobody wants a
    # coding agent read out loud; they want to know whether the thing finished.
    # So the concierge is answered from the daemon's own state, and never waits
    # for a session's turn — see call.py.

    def call_snapshot(self):
        return call_snapshot(self.db, self.sessions, self.cfg.host_name)

    def _concierge_actions(self) -> dict:
        """The four things the concierge may do, as the daemon already does them.

        Each one goes through the same path the phone's own buttons use, so a
        session started by voice is a session like any other: same permission
        mode, same approvals coming back to the phone, same place in the list.
        Nothing here is a shortcut around the session layer."""

        async def send(chat_id: str, text: str) -> bool:
            return await self.sessions.get(chat_id).send(text.strip(), None)

        async def start(project: str, instruction: str) -> str:
            want = project.strip().casefold()
            hits = [p for p in self.policy.list_projects()
                    if p["name"].casefold() == want]
            if not hits:
                hits = [p for p in self.policy.list_projects()
                        if want and want in p["name"].casefold()]
            if not hits:
                raise Err("no_project", f"there is no project called {project}")
            cwd = hits[0]["path"]
            chat = await self.h_chat_create(None, {"cwd": cwd, "title": instruction[:60]})
            await self.sessions.get(chat["id"]).send(instruction.strip(), None)
            return hits[0]["name"]

        async def approve(chat_id: str, allow: bool) -> None:
            s = self.sessions.peek(chat_id)
            if not s or not s.pending:
                raise Err("no_pending_approval", "nothing is waiting there")
            request_id = next(iter(s.pending))
            # Whether it is dangerous is already decided and already written
            # down; read it back rather than judging it again here.
            danger = False
            for ev in self.db.tail_events(chat_id, ("approval.request",), limit=8):
                if (ev["data"] or {}).get("request_id") == request_id:
                    danger = bool((ev["data"] or {}).get("danger"))
                    break
            if danger and allow:
                raise PermissionError(
                    "that one is destructive; it has to be approved in the app")
            s.respond(request_id, "allow" if allow else "deny")

        async def stop(chat_id: str) -> None:
            s = self.sessions.peek(chat_id)
            if s:
                await s.interrupt()

        return {"send": send, "start": start, "approve": approve, "stop": stop}

    def _concierge_account(self) -> tuple[str | None, dict[str, str]]:
        """The concierge speaks as the computer, so it uses the computer's own
        Claude login rather than any one chat's account."""
        a = self._account(None, "claude")
        return a.home, a.env()

    async def h_call_hello(self, dev: Device, d: dict) -> dict:
        """Picking up the phone.

        Answers off one SQLite read so the greeting is immediate, and starts the
        model session in the background while the caller is being greeted. By
        the time they have finished saying what they want, the session that
        would have cost them five seconds is already open."""
        asyncio.create_task(self.concierge.warm())
        return call_headline(self.db, self.sessions)

    async def h_call_ask(self, dev: Device, d: dict) -> dict:
        text = str(d.get("text") or "").strip()
        if not text:
            raise Err("empty_message", "empty question")
        if d.get("reset"):
            await self.concierge.reset()
        return await self.concierge.ask(text, d.get("lang"))

    async def h_call_digest(self, dev: Device, d: dict) -> dict:
        """The snapshot itself, with no model in the way. Answering a status
        question badly is almost always the snapshot's fault, not the model's,
        and this is how you find out which."""
        return {"digest": self.call_snapshot()[0]}


    # ── accounts ───────────────────────────────────────────────────────────
    async def h_account_list(self, dev: Device, d: dict) -> dict:
        # Each refresh shells out to a CLI, so asking them one after another
        # made the list take as long as the slowest tool times the account count.
        await asyncio.gather(*(asyncio.to_thread(acct.refresh, a) for a in self.accounts.values()))
        order = {"claude": 0, "codex": 1}
        items = sorted(self.accounts.values(), key=lambda a: (order.get(a.provider, 9), a.home is not None, a.created_at))
        return {"accounts": [a.public() for a in items]}

    def _check_label(self, provider: str, label: str, skip: str = "") -> None:
        """Two accounts with the same name on one tool are indistinguishable in
        every picker in the app."""
        want = label.strip().casefold()
        if not want:
            return
        for a in self.accounts.values():
            if a.provider == provider and a.id != skip and a.label.strip().casefold() == want:
                raise Err("duplicate_label", "an account with that name already exists")

    async def h_account_rename(self, dev: Device, d: dict) -> dict:
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        if not a.home:
            raise Err("default_account", "this computer's own account cannot be renamed")
        label = str(d.get("label") or "").strip()[:40]
        if not label:
            raise Err("empty_label", "give the account a name")
        self._check_label(a.provider, label, skip=a.id)
        a.label = label
        self._save_accounts()
        return a.public()

    async def h_account_create(self, dev: Device, d: dict) -> dict:
        label = str(d.get("label") or "").strip()[:40]
        self._check_label(d.get("provider", ""), label)
        a = acct.new_account(d.get("provider", ""), label)
        self.accounts[a.id] = a
        self._save_accounts()
        return a.public()

    async def h_account_login(self, dev: Device, d: dict, ws: WebSocket) -> dict:
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        old = self.logins.pop(a.id, None)
        if old:
            await old.cancel()                      # one live login per account
        live = [s for s in self.logins.values() if not s.done]
        if len(live) >= acct.MAX_LOGINS:
            raise Err("too_many_logins", "too many sign-ins are already in progress")

        async def emit(kind: str, payload: dict) -> None:
            # Only the phone that asked; never written to the event table.
            try:
                await ws.send_text(json.dumps({"type": "event", "event": kind, "chat_id": None,
                                               "seq": None, "data": payload, "ts": time.time()},
                                              ensure_ascii=False, default=str))
            except Exception:
                pass
            if kind == "account.login.done":
                self._save_accounts()

        email = str(d.get("email") or "").strip()[:200]
        method = str(d.get("method") or "").strip() or acct.default_method(a.provider)
        key = str(d.get("api_key") or "").strip()
        log.info("login started account=%s provider=%s method=%s email=%s",
                 a.id, a.provider, method, bool(email))

        # A key is not a browser flow: there is nothing to watch, so it is done
        # here and answered straight away.
        if method == "api_key":
            if not key:
                raise Err("key_required", "paste the key for that sign-in method")
            await self._release_chats(a.id)
            a, ok, why = await asyncio.to_thread(acct.login_with_key, a, key)
            self.accounts[a.id] = a
            self._save_accounts()
            log.info("key sign-in account=%s ok=%s", a.id, ok)
            await emit("account.login.done", {
                "account_id": a.id, "ok": ok, "detail": a.detail,
                "error": None if ok else why, "error_code": None if ok else "bad_key",
                "retryable": not ok,
            })
            return {"started": True, "provider": a.provider, "needs_code": False}

        s = acct.LoginSession(a, emit, email=email, method=method, api_key=key)
        self.logins[a.id] = s
        await s.start()
        return {"started": True, "provider": a.provider, "needs_code": s.needs_code}

    async def h_account_login_submit(self, dev: Device, d: dict) -> dict:
        s = self.logins.get(d.get("account_id", ""))
        if s is None or s.done:
            raise Err("no_pending_login", "no sign-in is waiting for a code")
        await s.submit_code(str(d.get("code") or ""))
        return {}

    async def h_account_login_cancel(self, dev: Device, d: dict) -> dict:
        s = self.logins.pop(d.get("account_id", ""), None)
        if s:
            await s.cancel()
        return {}

    async def h_account_export(self, dev: Device, d: dict) -> dict:
        """Hand this account's stored sign-in to the phone so it can be moved to
        another computer. The blob is a bearer credential: the app keeps it in
        memory for one transfer and never writes it to disk. The phone calls
        account.forget here once the destination has verified it — two computers
        cannot share one login, the refresh token is single-use."""
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        await asyncio.to_thread(acct.refresh, a)
        if not a.logged_in:
            raise Err("no_credentials", "that account is not signed in on this computer")
        blob = await asyncio.to_thread(acct.export_credentials, a)
        log.warning("sign-in exported: account=%s provider=%s device=%s",
                    a.id, a.provider, dev.name)
        return {"provider": a.provider, "label": a.label, "detail": a.detail, "credentials": blob}

    async def h_account_import(self, dev: Device, d: dict) -> dict:
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        blob = d.get("credentials")
        await self._release_chats(a.id)
        a = await asyncio.to_thread(acct.import_credentials, a, blob)
        self._save_accounts()
        log.warning("sign-in imported: account=%s provider=%s device=%s",
                    a.id, a.provider, dev.name)
        # `auth status` reads a local file, so it would call a revoked token
        # healthy. Ask the tool to actually reach the service before saying yes.
        ok, why = await asyncio.to_thread(acct.verify_signed_in, a)
        return {**a.public(), "verified": ok, "verify_error": None if ok else why}

    async def h_account_forget(self, dev: Device, d: dict) -> dict:
        """Clear this computer's copy of a sign-in that was moved elsewhere.
        Local only: a real sign-out would revoke the token the other computer
        is now using."""
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        await self._release_chats(a.id)
        await asyncio.to_thread(acct.forget_credentials, a)
        log.warning("sign-in moved away: account=%s provider=%s device=%s",
                    a.id, a.provider, dev.name)
        return a.public()

    async def h_account_logout(self, dev: Device, d: dict) -> dict:
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        await self._release_chats(a.id)
        await asyncio.to_thread(acct.logout, a)
        return a.public()

    async def h_account_delete(self, dev: Device, d: dict) -> dict:
        a = self.accounts.get(d.get("account_id", ""))
        if a is None:
            raise Err("account_gone", "that account was removed")
        if not a.home:
            raise Err("default_account", "this computer's own account cannot be removed")
        await self._release_chats(a.id)
        s = self.logins.pop(a.id, None)
        if s:
            await s.cancel()
        await asyncio.to_thread(acct.delete_account_dir, a)
        self.accounts.pop(a.id, None)
        self._save_accounts()
        return {}

    async def _release_chats(self, account_id: str) -> None:
        """Free every chat bound to this account: a running turn is interrupted,
        the CLI session is dropped and the binding cleared — a resume id from one
        account is meaningless under another."""
        for chat in self.db.list_chats(include_archived=True):
            if chat.get("account_id") != account_id:
                continue
            live = self.sessions.peek(chat["id"])
            if live and live.is_busy():
                await live.interrupt()
            await self.sessions.drop(chat["id"])
            updated = self.db.update_chat(chat["id"], account_id=None, provider_session_id=None)
            await self.broadcast({"seq": None, "chat_id": chat["id"], "event": "chat.updated",
                                  "data": updated, "ts": time.time()})

    # ── info ───────────────────────────────────────────────────────────────
    def catalog(self) -> dict:
        cat = {name: cls.catalog() for name, cls in PROVIDERS.items()}
        if self._codex_models:
            cat["codex"]["models"] = self._codex_models
        return cat

    async def catalog_async(self) -> dict:
        """Static catalog, plus Codex's live model list once it has been fetched.
        The fetch runs at most once per daemon lifetime and never blocks hello for long."""
        if self._codex_models is None and self._codex_models_task is None:
            self._codex_models_task = asyncio.create_task(codex_live_models())
        if self._codex_models_task and not self._codex_models_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._codex_models_task), timeout=3)
            except Exception:
                pass
        if self._codex_models_task and self._codex_models_task.done() and self._codex_models is None:
            try:
                self._codex_models = self._codex_models_task.result()
            except Exception:
                self._codex_models = None
            if self._codex_models is None:
                self._codex_models_task = None  # retry on a later call
        return self.catalog()

    def host_info(self) -> dict:
        if self._versions is None:
            self._versions = {p: tools.version(p) for p in ("claude", "codex")}
        return {
            "name": self.cfg.host_name, "os": platform.system(), "os_version": _os_version(),
            "daemon_version": __version__, "uptime_s": int(time.time() - self.started),
            # The version above is a constant; this is what is actually running.
            "revision": self.updater.state.get("local"),
            "update": {k: self.updater.state.get(k) for k in
                       ("behind", "ahead", "auto", "repo", "error", "checked_at")},
            "active_sessions": self.sessions.active_count(),
            "connected_devices": len(self.clients),
            "versions": self._versions, "roots": self.cfg.allowed_roots,
            "transcription": transcribe_available(),
            "npm": tools.npm_available(),
        }

    async def reaper(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.sessions.reap_idle()
            except Exception as exc:
                log.warning("reaper: %s", exc)


def _normalize_image(path: Path) -> Path:
    """HEIC or oversized photos → JPEG ≤ 1600 px so Claude Code's Read (256 KB cap for
    text, image previews OK up to a few MB) can actually look at them.

    macOS has `sips` built in; elsewhere Pillow does the same job. Without either
    the file is passed through untouched and the model may not be able to read it."""
    try:
        heic = path.suffix.lower() in (".heic", ".heif")
        big = path.stat().st_size > 600 * 1024
        if not (heic or big):
            return path
        out = path.with_suffix(".jpg") if heic else path.with_name(path.stem + "-web.jpg")
        if shutil.which("sips"):
            r = subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "1600",
                                str(path), "--out", str(out)], capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and out.exists():
                if out != path:
                    path.unlink(missing_ok=True)
                return out
            log.warning("sips failed: %s", r.stderr.strip()[:200])
        if _pillow_resize(path, out):
            if out != path:
                path.unlink(missing_ok=True)
            return out
        log.warning("no image converter available (install Pillow) — sending %s as is", path.name)
    except Exception as exc:
        log.warning("image normalize failed: %s", exc)
    return path


def _pillow_resize(src: Path, dst: Path) -> bool:
    """Pillow path, used on Windows and Linux. HEIC needs pillow-heif."""
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        try:
            import pillow_heif                      # noqa: F401
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((1600, 1600))
            im.save(dst, "JPEG", quality=82, optimize=True)
        return dst.exists()
    except Exception as exc:
        log.warning("pillow convert failed: %s", exc)
        return False


def _os_version() -> str:
    if sys.platform == "darwin":
        return platform.mac_ver()[0] or platform.release()
    if sys.platform == "win32":
        return platform.version()          # "10.0.26200" (release() says "10" on Windows 11)
    return platform.release()


def _ver(cmd: list[str]) -> str | None:
    exe = shutil.which(cmd[0])          # resolves .cmd/.exe shims on Windows
    if not exe:
        return None
    try:
        r = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=5)
        return (r.stdout or r.stderr).strip().splitlines()[0][:40]
    except Exception:
        return None
