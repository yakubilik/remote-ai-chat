"""Codex provider via `codex app-server` (JSON-RPC-ish over stdio, one process per chat).

Verified against codex-cli 0.117: requests are {"id","method","params"}, responses
{"id","result"|"error"}, notifications {"method","params"}, and server→client
requests (approvals) carry an "id" we answer with {"id","result"}.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import tomllib
from pathlib import Path
from typing import Any

from ..errors import Err
from ..security import destructive_reason, redact
from .. import tools
from .base import Provider, ProviderConfig, TurnResult

log = logging.getLogger("rac.codex")

EFFORTS = ["low", "medium", "high", "xhigh"]
# perm_mode -> (approvalPolicy, sandbox)
PERM_MODES: dict[str, tuple[str, str]] = {
    "suggest":   ("untrusted",  "read-only"),
    "auto-edit": ("on-request", "workspace-write"),
    "full-auto": ("on-failure", "workspace-write"),
    # bypass: sandbox off, but keep "untrusted" so every command still passes
    # through the daemon, which auto-accepts everything except the destructive list.
    "bypass":    ("untrusted",  "danger-full-access"),
}
FALLBACK_MODELS = [
    {"id": "gpt-5.4", "label": "GPT-5.4", "hint": "default"},
    {"id": "gpt-5.4-mini", "label": "GPT-5.4 mini", "hint": "fast"},
]


def _default_model() -> str:
    try:
        cfg = tomllib.loads((Path.home() / ".codex" / "config.toml").read_text())
        return str(cfg.get("model") or FALLBACK_MODELS[0]["id"])
    except Exception:
        return FALLBACK_MODELS[0]["id"]


async def live_models(timeout: float = 12) -> list[dict] | None:
    """Ask `codex app-server` for model/list. Returns None if codex is missing or slow."""
    cli = tools.find_cli("codex")
    if not cli:
        return None
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    env.pop("CODEX_HOME", None)
    proc = await asyncio.create_subprocess_exec(
        cli, "app-server", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env)
    assert proc.stdin and proc.stdout

    async def go() -> list[dict] | None:
        proc.stdin.write((json.dumps({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "remote-ai-chat", "version": "0.1.0"}}}) + "\n").encode())
        proc.stdin.write((json.dumps({"id": 2, "method": "model/list", "params": {}}) + "\n").encode())
        await proc.stdin.drain()
        while True:
            line = await proc.stdout.readline()
            if not line:
                return None
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if m.get("id") == 2:
                out = []
                for md in (m.get("result") or {}).get("data") or []:
                    if md.get("hidden"):
                        continue
                    out.append({"id": md["id"], "label": md.get("displayName") or md["id"],
                                "hint": ("default · " if md.get("isDefault") else "") + (md.get("description") or "")[:40],
                                "efforts": [e["reasoningEffort"] for e in md.get("supportedReasoningEfforts") or []],
                                "default_effort": md.get("defaultReasoningEffort")})
                return out or None
    try:
        return await asyncio.wait_for(go(), timeout=timeout)
    except Exception as exc:
        log.warning("codex model/list failed: %s", exc)
        return None
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


class CodexProvider(Provider):
    name = "codex"

    def __init__(self, cfg: ProviderConfig, emit, approval):
        super().__init__(cfg, emit, approval)
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._rid = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._thread_id: str | None = cfg.session_id
        self._turn_id: str | None = None
        self._turn_done: asyncio.Event | None = None
        self._turn_result: dict | None = None
        self._turn_error: str | None = None
        self._usage: dict | None = None
        self._session_allow_cmds = False
        # per-turn streaming state
        self._segment = 0
        self._seg_text: list[str] = []
        self._streamed = 0
        self._started_items: set[str] = set()

    @staticmethod
    def catalog() -> dict:
        models = list(FALLBACK_MODELS)
        d = _default_model()
        if not any(m["id"] == d for m in models):
            models.insert(0, {"id": d, "label": d, "hint": "from config.toml"})
        return {"models": models, "efforts": EFFORTS, "perm_modes": list(PERM_MODES.keys())}

    # ── process / rpc ──────────────────────────────────────────────────────
    async def _ensure(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            return
        cli = tools.find_cli("codex")
        if not cli:
            raise Err("cli_missing", "the codex CLI is not installed")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
        env.pop("CODEX_HOME", None)
        if self.cfg.account_home:
            env["CODEX_HOME"] = self.cfg.account_home
        self._proc = await asyncio.create_subprocess_exec(
            cli, "app-server",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env=env, cwd=self.cfg.cwd,
        )
        self._reader = asyncio.create_task(self._read_loop())
        await self._call("initialize", {"clientInfo": {"name": "remote-ai-chat", "version": "0.1.0"}})
        policy, sandbox = PERM_MODES.get(self.cfg.perm_mode, PERM_MODES["auto-edit"])
        base = {"cwd": self.cfg.cwd, "approvalPolicy": policy, "sandbox": sandbox, "model": self.cfg.model}
        if self._thread_id:
            try:
                r = await self._call("thread/resume", {"threadId": self._thread_id, **base})
                self._thread_id = r["thread"]["id"]
                log.info("codex resumed thread %s", self._thread_id)
                return
            except Exception as exc:
                log.warning("codex resume failed (%s); starting new thread", exc)
        r = await self._call("thread/start", base)
        self._thread_id = r["thread"]["id"]
        log.info("codex started thread %s cwd=%s model=%s", self._thread_id, self.cfg.cwd, self.cfg.model)

    async def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()

    async def _call(self, method: str, params: dict, timeout: float = 60) -> Any:
        self._rid += 1
        rid = self._rid
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._send({"id": rid, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(rid, None)

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                try:
                    await self._handle(m)
                except Exception:
                    log.exception("codex message handling failed")
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("codex app-server exited"))
            if self._turn_done and not self._turn_done.is_set():
                self._turn_error = self._turn_error or "codex app-server exited"
                self._turn_done.set()

    async def _handle(self, m: dict) -> None:
        # response
        if "id" in m and "method" not in m:
            fut = self._pending.get(m["id"])
            if fut and not fut.done():
                if "error" in m:
                    fut.set_exception(RuntimeError(m["error"].get("message", "codex error")))
                else:
                    fut.set_result(m.get("result"))
            return
        method = m.get("method", "")
        params = m.get("params") or {}
        # server → client request
        if "id" in m:
            asyncio.create_task(self._server_request(m["id"], method, params))
            return
        await self._notification(method, params)

    # ── approvals ──────────────────────────────────────────────────────────
    async def _server_request(self, rid: Any, method: str, params: dict) -> None:
        result: dict
        try:
            if method == "item/commandExecution/requestApproval":
                cmd = params.get("command") or ""
                reason = destructive_reason(cmd)
                # Bypass answers everything itself, destructive included: it is
                # the mode picked to stop being interrupted.
                if self.cfg.perm_mode == "bypass" or (reason is None and self._session_allow_cmds):
                    decision = "allow"
                else:
                    decision = await self.approval("Bash", {"command": cmd, "cwd": params.get("cwd")}, reason)
                if decision == "allow_session" and reason is None:
                    self._session_allow_cmds = True
                result = {"decision": {"allow": "accept", "allow_session": "acceptForSession"}.get(decision, "decline")}
            elif method == "item/fileChange/requestApproval":
                if self.cfg.perm_mode == "bypass":
                    decision = "allow"
                else:
                    decision = await self.approval("Edit", {"file_path": params.get("grantRoot") or "(file change)",
                                                            "reason": params.get("reason")}, None)
                result = {"decision": {"allow": "accept", "allow_session": "acceptForSession"}.get(decision, "decline")}
            elif method == "item/permissions/requestApproval":
                decision = "allow" if self.cfg.perm_mode == "bypass" else await self.approval(
                    "Permissions", {"permissions": params.get("permissions"), "reason": params.get("reason")}, None)
                granted = params.get("permissions") if decision in ("allow", "allow_session") else {}
                result = {"permissions": granted or {}, "scope": "session" if decision == "allow_session" else "turn"}
            elif method == "item/tool/requestUserInput":
                result = {"answers": {}}
            else:
                log.warning("unhandled codex server request %s", method)
                result = {}
        except Exception as exc:
            log.warning("approval handling failed: %s", exc)
            result = {"decision": "decline"}
        await self._send({"id": rid, "result": result})

    # ── notifications → events ─────────────────────────────────────────────
    async def _flush(self, final_text: str | None = None) -> None:
        text = (final_text if final_text is not None else "".join(self._seg_text)).strip()
        if text:
            await self.emit("message.assistant", {"segment": self._segment, "text": redact(text)}, True)
        self._segment += 1
        self._seg_text = []
        self._streamed = 0

    async def _notification(self, method: str, p: dict) -> None:
        if method == "item/agentMessage/delta":
            d = p.get("delta") or ""
            if d:
                self._seg_text.append(d)
                self._streamed += len(d)
                await self.emit("text.delta", {"segment": self._segment, "text": d}, False)
        elif method in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
            if p.get("delta"):
                await self.emit("thinking.delta", {"text": p["delta"]}, False)
        elif method == "item/started":
            await self._item(p.get("item") or {}, started=True)
        elif method == "item/completed":
            await self._item(p.get("item") or {}, started=False)
        elif method == "thread/tokenUsage/updated":
            self._usage = p.get("tokenUsage") or p
        elif method == "error":
            err = (p.get("error") or {}).get("message")
            if err and not p.get("willRetry"):
                self._turn_error = err
        elif method == "turn/completed":
            turn = p.get("turn") or {}
            self._turn_result = turn
            if turn.get("status") == "failed" and turn.get("error"):
                self._turn_error = turn["error"].get("message") or self._turn_error
            if self._turn_done:
                self._turn_done.set()

    async def _item(self, item: dict, started: bool) -> None:
        t = item.get("type")
        iid = item.get("id", "")
        if t == "agentMessage":
            if not started:
                # authoritative final text; if nothing streamed, emit it as a delta first
                if self._streamed == 0 and item.get("text"):
                    await self.emit("text.delta", {"segment": self._segment, "text": item["text"]}, False)
                await self._flush(item.get("text"))
            return
        if t == "commandExecution":
            if started:
                await self._flush()
                self._started_items.add(iid)
                await self.emit("tool.use", {"id": iid, "tool": "Bash", "input": {"command": item.get("command", ""), "cwd": item.get("cwd")}}, True)
            else:
                if iid not in self._started_items:
                    await self._flush()
                    await self.emit("tool.use", {"id": iid, "tool": "Bash", "input": {"command": item.get("command", "")}}, True)
                code = item.get("exitCode")
                out = item.get("aggregatedOutput") or ""
                status = item.get("status")
                await self.emit("tool.result", {"id": iid, "output": redact(out)[:4000],
                                                "is_error": bool(status in ("failed", "declined") or (code not in (None, 0)))}, True)
            return
        if t == "fileChange":
            changes = item.get("changes") or []
            if started:
                await self._flush()
                self._started_items.add(iid)
                await self.emit("tool.use", {"id": iid, "tool": "Edit", "input": {
                    "file_path": ", ".join(c.get("path", "") for c in changes)[:300],
                    "diff": "\n".join((c.get("diff") or "") for c in changes)[:3000]}}, True)
            else:
                if iid not in self._started_items:
                    await self._flush()
                    await self.emit("tool.use", {"id": iid, "tool": "Edit", "input": {
                        "file_path": ", ".join(c.get("path", "") for c in changes)[:300],
                        "diff": "\n".join((c.get("diff") or "") for c in changes)[:3000]}}, True)
                await self.emit("tool.result", {"id": iid, "output": f"{len(changes)} file(s) · {item.get('status')}",
                                                "is_error": item.get("status") in ("failed", "declined")}, True)
            return
        if t in ("mcpToolCall", "dynamicToolCall", "webSearch"):
            if started:
                await self._flush()
                self._started_items.add(iid)
                name = item.get("tool") or ("WebSearch" if t == "webSearch" else t)
                await self.emit("tool.use", {"id": iid, "tool": name, "input": {"query": item.get("query"), "arguments": item.get("arguments")}}, True)
            else:
                if iid in self._started_items:
                    res = item.get("result") or item.get("contentItems") or item.get("action") or ""
                    await self.emit("tool.result", {"id": iid, "output": redact(json.dumps(res, ensure_ascii=False))[:4000] if not isinstance(res, str) else redact(res)[:4000],
                                                    "is_error": item.get("status") == "failed" or item.get("error") is not None}, True)
            return
        # userMessage, reasoning, plan, contextCompaction … ignored

    # ── Provider API ───────────────────────────────────────────────────────
    async def run(self, prompt: str, attachments: list[dict] | None = None) -> TurnResult:
        started = time.monotonic()
        try:
            await self._ensure()
        except Exception as exc:
            await self.close()
            return TurnResult(self._thread_id, None, None, None, None, True, f"codex could not start: {exc}")

        self._segment, self._seg_text, self._streamed = 0, [], 0
        self._started_items = set()
        self._turn_done = asyncio.Event()
        self._turn_result, self._turn_error = None, None

        inputs: list[dict] = [{"type": "text", "text": prompt, "text_elements": []}]
        for a in attachments or []:
            if a.get("path"):
                inputs.append({"type": "localImage", "path": a["path"]})
        params: dict = {"threadId": self._thread_id, "input": inputs}
        if self.cfg.effort in EFFORTS:
            params["effort"] = self.cfg.effort
        try:
            r = await self._call("turn/start", params)
            self._turn_id = (r or {}).get("turn", {}).get("id")
        except Exception as exc:
            await self.close()
            return TurnResult(self._thread_id, None, None, None, None, True, f"turn/start failed: {exc}")

        await self._turn_done.wait()
        await self._flush()
        dur = int((time.monotonic() - started) * 1000)
        turn = self._turn_result or {}
        status = turn.get("status")
        is_err = status == "failed" or (self._turn_error is not None and status != "completed")
        usage = None
        if self._usage:
            last = self._usage.get("last") or {}
            usage = {"input_tokens": last.get("inputTokens"), "output_tokens": last.get("outputTokens"),
                     "total_tokens": last.get("totalTokens")}
        return TurnResult(session_id=self._thread_id, cost_usd=None, usage=usage, duration_ms=dur,
                          num_turns=None, is_error=is_err, error=self._turn_error if is_err else None,
                          stop_reason=status)

    async def interrupt(self) -> None:
        if self._proc is None or not self._thread_id or not self._turn_id:
            return
        try:
            await self._call("turn/interrupt", {"threadId": self._thread_id, "turnId": self._turn_id}, timeout=5)
        except Exception as exc:
            log.warning("codex interrupt failed: %s", exc)

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._proc = None
