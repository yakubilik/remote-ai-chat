"""ChatSession: one per chat; owns the provider, approvals and event fan-out."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Awaitable, Callable

from .config import Config
from .db import DB, new_id
from .errors import Err
from . import preamble
from .providers.base import Provider, ProviderConfig
from .providers.claude import ClaudeProvider
from .providers.codex import CodexProvider

log = logging.getLogger("rac.session")

PROVIDERS: dict[str, type[Provider]] = {"claude": ClaudeProvider, "codex": CodexProvider}
NEW_CHAT_TITLE = "New chat"
# How many messages may wait behind a running turn before a send is refused.
# A queue is a convenience, not an inbox: past this the phone is typing into
# a chat that will not catch up for a very long time.
MAX_QUEUED = 20

# Rebuilding a dropped CLI session from the chat's own event log.
# A chat outlives the CLI session behind it: switching account or tool clears the
# resume id, and the next turn opens a session that has never seen this chat.
RECAP_SCAN = 400          # events read from the tail of the log
RECAP_MESSAGES = 30       # messages kept after filtering
RECAP_MSG_CHARS = 1200    # per message
RECAP_TOTAL_CHARS = 12000 # whole recap

# Chat columns that _make_provider reads. Changing one of these means the live
# provider is built from stale settings and has to be rebuilt. Keep this in step
# with _make_provider: a field missing here is a setting the phone cannot change.
PROVIDER_FIELDS = frozenset({
    "provider", "model", "effort", "perm_mode", "cwd", "agent_id",
    "account_id", "provider_session_id", "max_turns", "max_budget_usd",
})

# broadcast(event_dict) -> None  (server fans out to connected devices)
BroadcastFn = Callable[[dict], Awaitable[None]]
# notify(kind, chat) -> None      (push notifications)
NotifyFn = Callable[[str, dict], Awaitable[None]]


class ChatSession:
    # set by SessionManager: chat -> the account's CLI home (raises if removed)
    resolve_account = None
    agent_prompt = None

    def __init__(self, chat: dict, db: DB, cfg: Config, broadcast: BroadcastFn, notify: NotifyFn):
        self.chat_id = chat["id"]
        self.db = db
        self.cfg = cfg
        self.broadcast = broadcast
        self.notify = notify
        self.provider: Provider | None = None
        self.running: asyncio.Task | None = None
        # Messages typed while a turn was still going. The running turn drains
        # them one by one when it finishes, so the phone never has to stop the
        # agent just to get a word in.
        self.queued: list[tuple[str, list[dict]]] = []
        self.pending: dict[str, asyncio.Future] = {}
        self.last_active = time.monotonic()
        # Wall clock at which the turn now running started, or None between
        # turns. `updated_at` cannot answer this — an approval moves it too —
        # and "how long has it been at this" is what the chat list wants to say.
        self.turn_started: float | None = None
        self.lock = asyncio.Lock()
        # settings changed since the provider was built; the next turn rebuilds
        self.dirty = False
        # transcript to hand a freshly opened CLI session, built once per provider
        self._recap: str | None = None

    # ── events ─────────────────────────────────────────────────────────────
    async def emit(self, type_: str, payload: dict, persist: bool) -> None:
        if persist:
            ev = self.db.append_event(self.chat_id, type_, payload)
        else:
            ev = {"seq": None, "chat_id": self.chat_id, "event": type_,
                  "data": payload, "ts": time.time()}
        await self.broadcast(ev)

    async def _set_status(self, status: str, **fields) -> None:
        chat = self.db.update_chat(self.chat_id, status=status, **fields)
        await self.broadcast({"seq": None, "chat_id": self.chat_id, "event": "chat.updated",
                              "data": chat, "ts": time.time()})

    # ── approvals ──────────────────────────────────────────────────────────
    async def _approval(self, tool: str, tool_input: dict, reason: str | None) -> str:
        req_id = new_id()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        preview = _preview(tool, tool_input)
        await self.emit("approval.request", {
            "request_id": req_id, "tool": tool, "input": tool_input,
            "preview": preview, "danger": reason is not None, "reason": reason,
        }, True)
        await self._set_status("awaiting_approval", last_preview=preview)
        chat = self.db.get_chat(self.chat_id) or {}
        await self.notify("approval", {**chat, "preview": preview})
        try:
            decision = await asyncio.wait_for(fut, timeout=self.cfg.approval_timeout_s)
        except asyncio.TimeoutError:
            decision = "deny"
        finally:
            self.pending.pop(req_id, None)
        await self.emit("approval.resolved", {"request_id": req_id, "decision": decision}, True)
        await self._set_status("running")
        return decision

    def respond(self, request_id: str, decision: str) -> bool:
        fut = self.pending.get(request_id)
        if fut is None or fut.done():
            return False
        fut.set_result(decision if decision in ("allow", "allow_session", "deny") else "deny")
        return True

    # ── provider ───────────────────────────────────────────────────────────
    def _make_provider(self, chat: dict) -> Provider:
        cls = PROVIDERS.get(chat["provider"], ClaudeProvider)
        home, env = self.resolve_account(chat) if self.resolve_account else (None, {})
        pc = ProviderConfig(
            account_home=home, account_id=chat.get("account_id"), account_env=env,
            model=chat["model"], effort=chat.get("effort"), perm_mode=chat["perm_mode"],
            agent_prompt=self.agent_prompt(chat) if self.agent_prompt else None,
            agent_name=chat.get("agent_id"),
            cwd=chat["cwd"], session_id=chat.get("provider_session_id"),
            max_turns=chat.get("max_turns"), max_budget_usd=chat.get("max_budget_usd"),
        )
        pc.preamble = preamble.build(self.cfg, pc, chat["provider"])
        provider = cls(pc, self.emit, self._approval)
        provider.on_idle_output = self._on_idle_output
        return provider

    def _build_recap(self, incoming: str) -> str | None:
        """The chat's recent transcript, addressed to a session that never saw it.

        A chat is not the CLI session behind it. Change the account or the tool
        and the resume id is gone — rightly, it means nothing to the new one —
        but the chat on screen still shows every message that came before. The
        model then wakes up blank behind a long conversation, and a "carry on"
        has nothing to carry on from.

        Left to itself the model goes looking for the missing context in the
        tool's transcript directory, which is keyed by working folder, not by
        chat. Every chat opened on the same folder is sitting in there, and the
        most recent one is not this one. That is how a chat gets answered as if
        it were a different chat entirely. The event log is the only record that
        is actually this chat's, so it is the one we replay.
        """
        last = self.db.last_seq(self.chat_id)
        if last <= 0:
            return None
        events = self.db.events(self.chat_id, since_seq=max(0, last - RECAP_SCAN),
                                limit=RECAP_SCAN)
        speakers = {"message.user": "User", "message.assistant": "You"}
        lines: list[str] = []
        for e in events:
            who = speakers.get(e["event"])
            if who is None:
                continue
            body = plain((e.get("data") or {}).get("text") or "")
            if body:
                lines.append(f"{who}: {body[:RECAP_MSG_CHARS]}")
        # _prepare announces the new message before a queued turn reaches this
        # point, so it can already be in the log. Quoting it back as history
        # would read as if the user had said it twice.
        # Exactly one copy can be there, so only one may be dropped: a user who
        # really did say the same thing twice keeps both.
        tail = f"User: {plain(incoming)[:RECAP_MSG_CHARS]}"
        if lines and lines[-1] == tail:
            lines.pop()
        if not lines:
            return None
        lines = lines[-RECAP_MESSAGES:]
        total = 0
        kept: list[str] = []
        for line in reversed(lines):
            total += len(line) + 1
            if kept and total > RECAP_TOTAL_CHARS:
                break
            kept.append(line)
        kept.reverse()
        body = "\n".join(kept)
        return (
            "[Remote AI Chat] Your session was restarted, so this chat's history "
            "is not in your context. It is still on the user's screen, and the "
            "message below continues it. What follows is the tail of this chat's "
            "own transcript.\n\n"
            "Do not go looking for more of it on disk. Transcript folders are "
            "keyed by working folder, and other chats share this one — the "
            "recent sessions you would find there are not this conversation. If "
            "what you need is not below, say so and ask.\n\n"
            f"--- transcript, oldest first ---\n{body}\n"
            "--- end of transcript ---\n\n"
            "The user's new message:\n\n"
        )

    async def reconfigure(self) -> None:
        """Called after chat settings change: drop the provider so the next turn
        picks up the new model/perm/account/cwd (resume id keeps the context).

        A turn in flight keeps the provider it started with — the CLI session is
        already connected with the old options and cannot be re-opened under it.
        The flag is what makes the change survive: the next turn rebuilds. Before
        it existed, a change made while the model was answering was dropped on the
        floor and the chat kept the old settings until the idle reaper got to it.
        """
        self.dirty = True
        if self.is_busy():
            return
        await self._rebuild()

    async def _rebuild(self) -> None:
        self.dirty = False
        if self.provider:
            await self.provider.close()
            self.provider = None

    # ── turn ───────────────────────────────────────────────────────────────
    def is_busy(self) -> bool:
        return self.running is not None and not self.running.done()

    async def send(self, text: str, attachments: list[dict] | None) -> bool:
        """Start a turn, or queue the message behind the one already running.

        Returns True when the message went to the back of the queue. Waiting for
        the agent to be free is the agent's job, not the phone's: nobody should
        have to stop a turn just to add a thought to it.
        """
        # The queue check and the turn's own drain share this lock, so a message
        # can never land after the running turn decided the queue was empty.
        async with self.lock:
            if self.is_busy():
                if len(self.queued) >= MAX_QUEUED:
                    raise Err("busy", "too many queued messages")
                self.queued.append((text, attachments or []))
                self.last_active = time.monotonic()
                await self.emit("message.user",
                                {"text": text, "attachments": attachments or [], "queued": True}, True)
                return True
            await self._prepare(text, attachments, announce=True)
            self.running = asyncio.create_task(self._run(text, attachments))
        return False

    async def _prepare(self, text: str, attachments: list[dict] | None, announce: bool) -> dict:
        """Everything a turn needs before it starts: fresh provider, user event,
        title, running status. Runs for queued messages too — those were already
        announced when they arrived, so they come through with announce=False."""
        self.last_active = time.monotonic()
        chat = self.db.get_chat(self.chat_id)
        if chat is None:
            raise Err("no_chat", "no such chat")
        if self.dirty:
            await self._rebuild()
        if self.provider is None:
            self.provider = self._make_provider(chat)
            # No resume id means a session with no memory of this chat. Build the
            # recap before the new message is appended, so it is not quoted back.
            self._recap = (None if chat.get("provider_session_id")
                           else self._build_recap(text))
        if announce:
            await self.emit("message.user", {"text": text, "attachments": attachments or []}, True)
        if chat["title"] == NEW_CHAT_TITLE:
            self.db.update_chat(self.chat_id, title=text.strip().split("\n")[0][:60])
        await self._set_status("running", last_preview=plain(text)[:200])
        return chat

    async def _on_idle_output(self) -> None:
        """The model spoke with nothing asked of it — open a turn for it.

        A background agent finishing hands the model a notification, and it
        answers. Nobody asked, so there was no turn, and what it said waited in
        the reader's queue until the next message came along and dragged it out
        under itself. That is the one-turn lag the phone kept showing: the
        answer to the last question, arriving on the next one.
        """
        async with self.lock:
            if self.is_busy():
                return          # the turn in flight reads it; see _run below
            if self.db.get_chat(self.chat_id) is None:
                return
            self.last_active = time.monotonic()
            await self._set_status("running")
            self.running = asyncio.create_task(self._run(None, None, continuation=True))

    async def _run(self, text: str | None, attachments: list[dict] | None,
                   continuation: bool = False) -> None:
        """Run the turn, then keep running whatever was queued behind it."""
        while True:
            await self._turn(text, attachments, continuation)
            continuation = False
            async with self.lock:
                if not self.queued:
                    # Nothing was asked, but the model may have carried on by
                    # itself while this turn ran — a background agent that
                    # finished halfway through it. That belongs to this chat
                    # now, not to whatever gets typed next.
                    if self.provider is not None and self.provider.has_pending():
                        text, attachments, continuation = None, None, True
                        continue
                    return
                text, attachments = self.queued.pop(0)
            # A queued message was already announced when it arrived; it only
            # needs the provider and the status that a fresh send would set up.
            try:
                await self._prepare(text, attachments, announce=False)
            except Exception as exc:
                log.exception("queued turn could not start")
                await self.emit("turn.error", {"message": str(exc)}, True)
                await self._set_status("idle", last_preview=f"Error: {exc}"[:200])
                return

    async def _turn(self, text: str | None, attachments: list[dict] | None,
                    continuation: bool = False) -> None:
        assert self.provider is not None
        self.turn_started = time.time()
        await self.emit("turn.started", {}, False)
        prompt = None
        if not continuation:
            prompt, self._recap = (f"{self._recap}{text}" if self._recap else text), None
        try:
            res = (await self.provider.run_continuation() if continuation
                   else await self.provider.run(prompt, attachments))
        except Exception as exc:
            log.exception("turn crashed")
            await self.emit("turn.error", {"message": str(exc)}, True)
            await self._finish(last_preview=f"Error: {exc}"[:200])
            return
        self.last_active = time.monotonic()
        chat = self.db.get_chat(self.chat_id) or {}
        fields: dict = {}
        if res.session_id:
            fields["provider_session_id"] = res.session_id
            ids = json.loads(chat.get("session_ids") or "{}")
            ids[chat["provider"]] = res.session_id
            fields["session_ids"] = json.dumps(ids)
        if res.cost_usd:
            fields["total_cost_usd"] = float(chat.get("total_cost_usd") or 0) + res.cost_usd
        if res.is_error:
            await self.emit("turn.error", {"message": res.error or "error"}, True)
            fields["last_preview"] = f"Error: {res.error}"[:200]
        else:
            await self.emit("turn.done", {
                "cost_usd": res.cost_usd, "usage": res.usage,
                "duration_ms": res.duration_ms, "num_turns": res.num_turns,
                "stop_reason": res.stop_reason,
            }, True)
            last = self.db.events(self.chat_id, since_seq=max(0, self.db.last_seq(self.chat_id) - 20))
            texts = [e["data"]["text"] for e in last if e["event"] == "message.assistant"]
            if texts:
                fields["last_preview"] = plain(texts[-1])[:200]
        await self._finish(**fields)

    async def _finish(self, **fields) -> None:
        """End of one turn. Only a turn with nothing queued behind it puts the
        chat back to idle and tells the phone it is done — otherwise the next
        queued message is about to start and the chat never stopped working."""
        self.turn_started = None
        if self.queued:
            await self._set_status("running", **fields)
            return
        await self._set_status("idle", **fields)
        await self.notify("done", self.db.get_chat(self.chat_id) or {})

    async def interrupt(self) -> None:
        # Stopping means stopping: what was waiting in line never asked to be
        # sent to an agent the user just cut off.
        async with self.lock:
            self.queued.clear()
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result("deny")
        if self.provider:
            await self.provider.interrupt()

    async def close(self) -> None:
        await self.interrupt()
        if self.running and not self.running.done():
            self.running.cancel()
        if self.provider:
            await self.provider.close()
            self.provider = None


class SessionManager:
    def __init__(self, db: DB, cfg: Config, broadcast: BroadcastFn, notify: NotifyFn,
                 resolve_account=None, agent_prompt=None):
        self.db, self.cfg, self.broadcast, self.notify = db, cfg, broadcast, notify
        self.resolve_account = resolve_account
        self.agent_prompt = agent_prompt
        self.sessions: dict[str, ChatSession] = {}

    def get(self, chat_id: str) -> ChatSession:
        s = self.sessions.get(chat_id)
        if s is None:
            chat = self.db.get_chat(chat_id)
            if chat is None:
                raise KeyError(chat_id)
            s = ChatSession(chat, self.db, self.cfg, self.broadcast, self.notify)
            s.resolve_account = self.resolve_account
            s.agent_prompt = self.agent_prompt
            self.sessions[chat_id] = s
        return s

    def peek(self, chat_id: str) -> ChatSession | None:
        return self.sessions.get(chat_id)

    async def drop(self, chat_id: str) -> None:
        s = self.sessions.pop(chat_id, None)
        if s:
            await s.close()

    async def reap_idle(self) -> None:
        now = time.monotonic()
        for cid, s in list(self.sessions.items()):
            if not s.is_busy() and now - s.last_active > self.cfg.idle_disconnect_s:
                log.info("reaping idle session %s", cid)
                await self.drop(cid)

    def active_count(self) -> int:
        return sum(1 for s in self.sessions.values() if s.is_busy())

    async def close_all(self) -> None:
        for cid in list(self.sessions):
            await self.drop(cid)


_MD = re.compile(r"(\*\*|__|`{1,3}|^#{1,6}\s+|^[-*]\s+|^\d+\.\s+)", re.M)


def plain(text: str) -> str:
    """Strip light markdown for list previews."""
    return re.sub(r"\s+", " ", _MD.sub("", text or "")).strip()


def _preview(tool: str, inp: dict) -> str:
    if tool == "Bash":
        return (inp.get("command") or "")[:200]
    for key in ("file_path", "path", "pattern", "url", "query", "prompt", "description"):
        if inp.get(key):
            return f"{tool} {str(inp[key])[:160]}"
    return tool
