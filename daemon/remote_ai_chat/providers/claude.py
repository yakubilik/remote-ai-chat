"""Claude Code provider via claude_agent_sdk.ClaudeSDKClient."""
from __future__ import annotations

import asyncio
import os
import logging
import time
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from ..config import UPLOAD_DIR
from ..security import destructive_reason, redact
from .base import Provider, ProviderConfig, TurnResult

log = logging.getLogger("rac.claude")

# Put on the inbox when the reader dies, so a turn waiting on it fails instead
# of hanging for a stream that has stopped.
_STREAM_BROKEN = object()

# How long a turn nobody asked for may sit in total silence before it is
# declared over. A turn that was asked for has no such ceiling — it may be
# waiting on a ten-minute command — but an unasked one is opened on a guess,
# and a guess that turns out wrong must not wedge the chat forever.
_CONTINUATION_IDLE_S = 180.0

MODEL_ALIASES = {
    "fable": "claude-fable-5-1",
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5-20251001",
}
PERM_MODES = {
    "ask": "default",
    "accept-edits": "acceptEdits",
    "plan": "plan",
    "bypass": "bypassPermissions",
}
EFFORTS = ["low", "medium", "high", "xhigh", "max"]


class ClaudeProvider(Provider):
    name = "claude"

    def __init__(self, cfg: ProviderConfig, emit, approval):
        super().__init__(cfg, emit, approval)
        self._client: ClaudeSDKClient | None = None
        self._session_allow: set[str] = set()
        self._session_id: str | None = cfg.session_id
        self._interrupted = False
        # One reader for the life of the client, and the queue it fills.
        self._reader: asyncio.Task | None = None
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._reader_error: Exception | None = None
        self._turn_active = False
        self._idle_notified = False
        self._pending_notify: asyncio.Task | None = None
        # How many messages sit in the inbox that are the model actually
        # speaking, rather than the housekeeping a connection also emits.
        self._spoken = 0

    @staticmethod
    def catalog() -> dict:
        return {
            "models": [
                {"id": "fable", "label": "Fable 5.1", "hint": "most capable"},
                {"id": "opus", "label": "Opus 5", "hint": "deep work"},
                {"id": "sonnet", "label": "Sonnet 5", "hint": "balanced"},
                {"id": "haiku", "label": "Haiku 4.5", "hint": "fast · cheap"},
            ],
            "efforts": EFFORTS,
            "perm_modes": list(PERM_MODES.keys()),
        }

    # ── permission plumbing ────────────────────────────────────────────────
    async def _pre_tool_hook(self, input_data: dict, tool_use_id: str | None, context: Any) -> dict:
        """The phone's say over Bash.

        The permission callback is never consulted for Bash — the tool runs
        whatever the callback answers, which was measured, not assumed. So the
        chat's permission mode is enforced here instead: in "ask" every command
        is put to the phone, and in the middle modes the destructive ones still
        are.

        Bypass asks nothing at all, and the hook is not even installed for it —
        a mode chosen to stop being asked that still interrupted a log tail was
        worse than no mode at all. The guard stays here too, because a hook
        that decides permissions must not depend on being wired up correctly.
        """
        if input_data.get("tool_name") != "Bash" or self.cfg.perm_mode == "bypass":
            return {}
        cmd = (input_data.get("tool_input") or {}).get("command", "") or ""
        reason = destructive_reason(cmd)
        if not reason:
            if self.cfg.perm_mode != "ask" or "Bash" in self._session_allow:
                return {}
        decision = await self.approval("Bash", input_data.get("tool_input") or {}, reason)
        if decision == "allow_session":
            self._session_allow.add("Bash")
        if decision in ("allow", "allow_session"):
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "allow",
                "permissionDecisionReason": "Approved from the phone.",
            }}
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "Denied from the phone.",
        }}

    async def _can_use_tool(self, tool_name: str, tool_input: dict, context: Any):
        if tool_name in self._session_allow:
            return PermissionResultAllow()
        # Files the user uploaded from the phone are implicitly readable.
        if tool_name == "Read":
            fp = str((tool_input or {}).get("file_path") or "")
            if fp.startswith(str(UPLOAD_DIR)):
                return PermissionResultAllow()
        decision = await self.approval(tool_name, tool_input or {}, None)
        if decision == "allow_session":
            self._session_allow.add(tool_name)
            return PermissionResultAllow()
        if decision == "allow":
            return PermissionResultAllow()
        return PermissionResultDeny(message="Denied by the user.", interrupt=False)

    # ── plan limits ────────────────────────────────────────────────────────
    @staticmethod
    def _limits(i) -> dict:
        """Every window of the plan, as the tool last measured it.

        The SDK models the headline of the CLI's report — the one window it is
        warning about — and keeps the rest of the payload in `raw`. The per
        window percentages live there, under `unifiedWindows`, and they are the
        only place a percentage appears on an ordinary turn. The headline is
        still carried alongside so that a window the CLI singles out keeps its
        status, and so older apps reading `window`/`utilization` still work.
        """
        raw = i.raw or {}
        unified = raw.get("unifiedWindows")
        windows: list[dict] = []
        if isinstance(unified, dict):
            for name, w in unified.items():
                if not isinstance(w, dict):
                    continue
                u = w.get("utilization")
                windows.append({
                    "window": name,
                    # Only the window the CLI named carries its status. The
                    # others are being reported precisely because nothing is
                    # wrong with them.
                    "status": i.status if name == i.rate_limit_type else "allowed",
                    "utilization": float(u) if isinstance(u, (int, float)) else None,
                    "resets_at": w.get("resetsAt"),
                })
        if not windows and i.rate_limit_type:
            # Older CLIs, and any report that arrives without the unified block.
            windows.append({"window": i.rate_limit_type, "status": i.status,
                            "utilization": i.utilization, "resets_at": i.resets_at})
        windows.sort(key=lambda w: w["window"])
        return {
            # The headline, kept for apps that predate the list below.
            "window": i.rate_limit_type, "status": i.status,
            "utilization": i.utilization, "resets_at": i.resets_at,
            "overage_status": i.overage_status,
            "overage_resets_at": i.overage_resets_at,
            "overage_disabled_reason": i.overage_disabled_reason,
            "is_using_overage": bool(raw.get("isUsingOverage")),
            "windows": windows,
        }

    # ── lifecycle ──────────────────────────────────────────────────────────
    def _options(self) -> ClaudeAgentOptions:
        c = self.cfg
        model = MODEL_ALIASES.get(c.model, c.model)
        # The account decides the environment: its config dir, and its key when
        # it was signed in with one. Anything inherited from the daemon's own
        # shell would quietly sign in as somebody else.
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY")}
        env.update({k: v for k, v in (c.account_env or {}).items()
                    if k in ("CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY")})
        if c.account_home:
            env["CLAUDE_CONFIG_DIR"] = c.account_home
        kw: dict[str, Any] = dict(
            env=env,
            cwd=c.cwd,
            model=model,
            permission_mode=PERM_MODES.get(c.perm_mode, "default"),
            include_partial_messages=True,
            max_buffer_size=32 * 1024 * 1024,   # big tool results (binary Read) must not kill the stream
            disallowed_tools=["AskUserQuestion"],
        )
        if c.perm_mode != "bypass":
            kw["hooks"] = {"PreToolUse": [HookMatcher(matcher="Bash", hooks=[self._pre_tool_hook])]}
        # Where it is first, then who it is. An agent's own definition is the
        # more specific instruction and so goes last, but it never replaces the
        # context: an agent that does not know it is being read on a phone
        # writes for a screen that is not there.
        append = "\n\n".join(p for p in (c.preamble, c.agent_prompt) if p)
        if append:
            kw["system_prompt"] = {"type": "preset", "preset": "claude_code",
                                   "append": append}
        if c.effort:
            kw["effort"] = c.effort
        if c.max_turns:
            kw["max_turns"] = c.max_turns
        if c.max_budget_usd:
            kw["max_budget_usd"] = c.max_budget_usd
        if self._session_id:
            kw["resume"] = self._session_id
        if c.perm_mode == "bypass":
            kw["extra_args"] = {"dangerously-skip-permissions": None}
        else:
            kw["can_use_tool"] = self._can_use_tool
        return ClaudeAgentOptions(**kw)

    async def _ensure_client(self) -> ClaudeSDKClient:
        if self._client is None:
            client = ClaudeSDKClient(options=self._options())
            await client.connect()
            self._client = client
            self._inbox = asyncio.Queue()
            self._reader_error = None
            self._idle_notified = False
            self._spoken = 0
            self._reader = asyncio.create_task(self._read_stream(client))
            log.info("claude client connected cwd=%s model=%s resume=%s",
                     self.cfg.cwd, self.cfg.model, self._session_id)
        return self._client

    async def close(self) -> None:
        # Disconnect first: the SDK stops its own reader as part of it, and
        # cancelling ours out from under it left it tearing down a transport
        # that was already half gone.
        if self._client is not None:
            try:
                await asyncio.wait_for(self._client.disconnect(), timeout=5)
            except Exception as exc:
                log.warning("disconnect failed: %s", exc)
            self._client = None
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
            self._reader = None
        # A turn waiting on the reader must be told the reader is gone. Without
        # this it waits on a queue nobody will fill again and the chat stays
        # "running" for good.
        self._inbox.put_nowait(_STREAM_BROKEN)

    async def interrupt(self) -> None:
        if self._client is None:
            return
        self._interrupted = True
        try:
            await asyncio.wait_for(self._client.interrupt(), timeout=3)
        except Exception as exc:
            log.warning("interrupt failed (%s); resetting client", exc)
            await self.close()

    # ── the reader ─────────────────────────────────────────────────────────
    async def _read_stream(self, client: ClaudeSDKClient) -> None:
        """Read the CLI for as long as the client lives.

        A turn ends; the stream does not. The CLI speaks without being asked —
        a background agent finishing hands the model a notification and it
        answers — and the SDK parks those messages in a 100-deep buffer. When
        the only reader was the turn loop, nobody emptied that buffer between
        turns: the unasked-for turn sat there until the next question was asked,
        was drained under *that* question, and ended the new turn at the old
        turn's ResultMessage. The real answer then waited for the message after
        it. Every reply after the first background agent arrived one turn late,
        for good, which is exactly what the phone saw.

        So the reader outlives the turn. What it reads with a turn in flight
        belongs to that turn; what it reads with none belongs to a turn the
        model started on its own, and the session is told to open one.
        """
        try:
            async for msg in client.receive_messages():
                speech = self._starts_a_turn(msg)
                if speech:
                    self._spoken += 1
                await self._inbox.put(msg)
                if self._turn_active or self._idle_notified:
                    continue
                cb = self.on_idle_output
                if cb is None or not speech:
                    continue
                # Told once per idle spell, and never awaited here: the handler
                # only starts the turn, and a reader that waited for a turn it
                # started would be a reader that stopped reading.
                self._idle_notified = True
                self._pending_notify = asyncio.create_task(cb())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("claude stream reader stopped")
            self._reader_error = exc
            await self._inbox.put(_STREAM_BROKEN)

    @staticmethod
    def _starts_a_turn(msg: Any) -> bool:
        """Whether this message is the model actually saying something.

        A connection emits housekeeping — hook events, `init`, rate-limit
        notices — and a finished turn is followed by more of it. None of that
        is a turn. Opening one for it produced an empty turn that then waited
        for a ResultMessage nobody was going to send, and the chat sat on
        "running" for good.

        Neither is a background agent. Its messages ride this same stream,
        tagged with the tool call that spawned it, and they keep coming long
        after the turn that launched it has ended — which is exactly when a
        chat has no turn in flight. The drain loop already skips anything
        carrying a `parent_tool_use_id`; counting it as speech here opened a
        continuation turn that then skipped every message it had been opened
        for and waited on a ResultMessage that belonged to no one. An idle
        ceiling does not save it either: a chatty helper resets the clock with
        every message, so the turn hangs for as long as the helper talks.
        """
        if getattr(msg, "parent_tool_use_id", None):
            return False
        if isinstance(msg, (AssistantMessage, UserMessage)):
            return True
        if isinstance(msg, StreamEvent):
            return msg.event.get("type") in (
                "message_start", "content_block_start", "content_block_delta")
        return False

    async def _iter_inbox(self, idle_timeout: float | None = None):
        """The messages of one turn, taken from the one reader.

        `idle_timeout` ends the turn when the stream falls completely silent
        for that long. Only a continuation sets it; see _CONTINUATION_IDLE_S.
        """
        while True:
            if idle_timeout is None:
                msg = await self._inbox.get()
            else:
                try:
                    msg = await asyncio.wait_for(self._inbox.get(), idle_timeout)
                except asyncio.TimeoutError:
                    log.warning("continuation turn idle for %ss; ending it",
                                idle_timeout)
                    return
            if msg is _STREAM_BROKEN:
                raise RuntimeError(f"stream closed: {self._reader_error}"
                                   if self._reader_error else "stream closed")
            if self._starts_a_turn(msg):
                self._spoken = max(0, self._spoken - 1)
            yield msg

    def has_pending(self) -> bool:
        """The model has said something nobody has opened a turn for yet.

        Only speech counts. A finished turn is followed by housekeeping — hook
        events, `init`, rate-limit notices, the tail stream events of the reply
        that just ended — and all of it lands in the same inbox. Reading "the
        queue is not empty" as "the model spoke" opened a continuation turn
        after almost every turn, and that turn then waited on a ResultMessage
        nobody was going to send. The session stayed busy for good and every
        message typed afterwards was queued behind a turn that never ended.
        """
        return self._spoken > 0

    # ── the turn ───────────────────────────────────────────────────────────
    async def run(self, prompt: str, attachments: list[dict] | None = None) -> TurnResult:
        # Claimed before the client exists: connecting emits hook events and
        # `init` straight away, and a reader that saw those with no turn in
        # flight would report the connection itself as something the model had
        # said unasked.
        self._turn_active = True
        client = await self._ensure_client()
        started = time.monotonic()
        self._interrupted = False

        if attachments:
            prompt = f"{prompt}\n\n{describe_attachments(attachments)}"

        try:
            await client.query(prompt)
        except Exception as exc:
            self._turn_active = False
            await self.close()
            return TurnResult(self._session_id, None, None, None, None, True, f"query failed: {exc}")

        return await self._drain(started)

    async def run_continuation(self) -> TurnResult:
        """Drain a turn the model began on its own. Nothing is asked of it."""
        self._turn_active = True
        await self._ensure_client()
        self._interrupted = False
        return await self._drain(time.monotonic(), idle_timeout=_CONTINUATION_IDLE_S)

    async def _drain(self, started: float,
                     idle_timeout: float | None = None) -> TurnResult:
        self._turn_active = True
        self._idle_notified = False
        try:
            return await self._drain_turn(started, idle_timeout)
        finally:
            self._turn_active = False

    async def _drain_turn(self, started: float,
                          idle_timeout: float | None = None) -> TurnResult:
        segment = 0
        tokens_done = 0      # output tokens from assistant messages already finished
        tokens_cur = 0       # ...and the one being generated
        open_tools = 0       # tool calls started but not yet answered
        last_progress = 0.0
        seg_text: list[str] = []
        # A text block is whole only at content_block_stop. Flushing before that
        # cut sentences — and words — in half ("olar" | tool card | "ak"), because
        # a tool call arriving mid-sentence used to end the segment where the
        # stream happened to be. Text is now emitted when the model finishes it.
        text_open = False
        msg_streamed = False   # this message delivered its text as deltas
        # Tool cards that showed up while a text block was still open. The SDK can
        # hand over a parsed AssistantMessage before the raw deltas behind it have
        # all arrived, so a tool call is not proof that the sentence in front of it
        # is finished. They wait here and go out in order once the text closes.
        pending_tools: list[dict] = []
        # How many tools each background agent has run. A `Task`/`Agent` tool
        # spawns an agent that talks on this same stream, and everything it says
        # carries the id of the tool call that started it. Its chatter is
        # reported under that id instead of being written into the conversation.
        sub_tools: dict[str, int] = {}

        async def sub_activity(parent: str, tool: str | None = None, text: str | None = None) -> None:
            """What a background agent is up to, addressed to its tool card.

            Deliberately not persisted: it is a progress indicator, not part of
            the conversation. The agent's actual answer arrives as the tool's
            result, which is persisted like any other.
            """
            if tool:
                sub_tools[parent] = sub_tools.get(parent, 0) + 1
            await self.emit("agent.activity", {
                "id": parent, "tools": sub_tools.get(parent, 0),
                "tool": tool, "text": redact((text or "").strip())[:200],
            }, False)

        async def flush_segment() -> None:
            """Emit whatever text has been collected as one assistant message.

            Silent when there is nothing to say, and the segment number only
            moves when something was actually sent — the phone keys its live
            buffer by that number and a gap would strand what it is typing.
            """
            nonlocal segment, seg_text
            text = "".join(seg_text).strip()
            seg_text = []
            if not text:
                return
            await self.emit("message.assistant", {"segment": segment, "text": redact(text)}, True)
            segment += 1

        async def release_tools() -> None:
            nonlocal pending_tools
            for payload in pending_tools:
                await self.emit("tool.use", payload, True)
            pending_tools = []

        async def progress(force: bool = False) -> None:
            nonlocal last_progress
            now = time.monotonic()
            if not force and now - last_progress < 0.4:
                return
            last_progress = now
            await self.emit("turn.progress", {
                "output_tokens": tokens_done + tokens_cur,
                "open_tools": open_tools,
            }, False)

        result: ResultMessage | None = None
        try:
            async for msg in self._iter_inbox(idle_timeout):
                # A background agent's messages ride this same stream, tagged
                # with the tool call that spawned it. Letting them through was
                # what put a helper's English "Now let me validate both files"
                # into the middle of the conversation — and, because a helper
                # only gets to speak when the stream next moves, put it there
                # one turn late, under whatever had just been asked. Worse, a
                # helper's `message_start` reset the main message's streaming
                # flag, so the real answer could be written out twice.
                parent = getattr(msg, "parent_tool_use_id", None)

                if isinstance(msg, StreamEvent):
                    if parent:
                        continue
                    ev = msg.event or {}
                    et = ev.get("type")
                    if et == "message_start":
                        tokens_done += tokens_cur
                        tokens_cur = 0
                        msg_streamed = False
                        await progress(force=True)
                    elif et == "message_delta":
                        u = ev.get("usage") or {}
                        if u.get("output_tokens") is not None:
                            tokens_cur = int(u["output_tokens"])
                            await progress()
                    if et == "content_block_start":
                        if (ev.get("content_block") or {}).get("type") == "text":
                            text_open = True
                    elif et == "content_block_stop":
                        # The model is done writing this block: now it can be sent
                        # whole, whatever the tool calls around it are doing.
                        if text_open:
                            text_open = False
                            await flush_segment()
                            await release_tools()
                    elif et == "content_block_delta":
                        d = ev.get("delta") or {}
                        if d.get("type") == "text_delta" and d.get("text"):
                            seg_text.append(d["text"])
                            msg_streamed = True
                            await self.emit("text.delta", {"segment": segment, "text": d["text"]}, False)
                        elif d.get("type") == "thinking_delta" and d.get("thinking"):
                            await self.emit("thinking.delta", {"text": d["thinking"]}, False)
                    continue

                if isinstance(msg, RateLimitEvent):
                    # What is left of the plan's windows. The CLI sends this on
                    # every turn, not only when a limit is close: the headline
                    # fields describe whichever window it is warning about, and
                    # `unifiedWindows` carries a percentage for every window
                    # there is. Reading only the headline was why the ring stayed
                    # empty — on an ordinary turn the headline has no percentage
                    # at all, and the one window it names is not the whole plan.
                    i = msg.rate_limit_info
                    await self.emit("limits", self._limits(i), False)
                    continue
                if isinstance(msg, SystemMessage):
                    if getattr(msg, "subtype", "") == "init":
                        sid = (getattr(msg, "data", None) or {}).get("session_id")
                        if sid:
                            self._session_id = sid
                    continue

                if isinstance(msg, AssistantMessage):
                    if parent:
                        for block in msg.content or []:
                            if isinstance(block, TextBlock) and block.text.strip():
                                await sub_activity(parent, text=block.text)
                            elif isinstance(block, ToolUseBlock):
                                await sub_activity(parent, tool=block.name)
                        continue
                    for block in msg.content or []:
                        if isinstance(block, TextBlock):
                            # Fallback when no deltas streamed for this message.
                            # Keyed on the message, not on the flush counter: the
                            # text block has usually been flushed by now, and
                            # asking "has anything been flushed?" would re-add it.
                            if not msg_streamed and block.text:
                                seg_text.append(block.text)
                                await self.emit("text.delta", {"segment": segment, "text": block.text}, False)
                        elif isinstance(block, ToolUseBlock):
                            open_tools += 1
                            await progress(force=True)
                            payload = {"id": block.id, "tool": block.name, "input": _trim(block.input)}
                            if text_open:
                                pending_tools.append(payload)
                            else:
                                await flush_segment()
                                await self.emit("tool.use", payload, True)
                        elif isinstance(block, ThinkingBlock):
                            pass
                    continue

                if isinstance(msg, UserMessage):
                    if parent:
                        # Its matching tool.use was never sent, so a result here
                        # would be a card with nothing to attach to.
                        continue
                    content = msg.content
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, ToolResultBlock):
                                open_tools = max(0, open_tools - 1)
                                await progress(force=True)
                                # The tool has already run, so its card is due even
                                # if the stream has not closed the text yet.
                                await release_tools()
                                await self.emit("tool.result", {
                                    "id": block.tool_use_id,
                                    "output": redact(_result_text(block.content))[:4000],
                                    "is_error": bool(block.is_error),
                                }, True)
                    continue

                if isinstance(msg, ResultMessage):
                    result = msg
                    break
        except Exception as exc:
            log.exception("receive loop failed")
            await flush_segment()
            await release_tools()
            await self.close()
            return TurnResult(self._session_id, None, None, None, None, True, f"stream failed: {exc}")

        await flush_segment()
        await release_tools()
        if result is None:
            if self._interrupted:
                return TurnResult(self._session_id, None, None, int((time.monotonic() - started) * 1000), None,
                                  False, None, "interrupted")
            return TurnResult(self._session_id, None, None,
                              int((time.monotonic() - started) * 1000), None, True, "no result")
        if result.session_id:
            self._session_id = result.session_id
        err = None
        if result.is_error and self._interrupted:
            # An interrupted turn is not a failure; report it as a normal stop.
            usage = result.usage if result.usage and any(result.usage.values()) else None
            return TurnResult(self._session_id, None, usage, result.duration_ms,
                              result.num_turns, False, None, "interrupted")
        if result.is_error:
            err = result.result or (result.errors[0] if result.errors else "unknown error")
        return TurnResult(
            session_id=self._session_id,
            cost_usd=result.total_cost_usd,
            usage=result.usage,
            duration_ms=result.duration_ms,
            num_turns=result.num_turns,
            is_error=bool(result.is_error),
            error=err,
            stop_reason=result.stop_reason,
        )


def describe_attachments(attachments: list[dict]) -> str:
    """Files are passed by path; Claude Code reads images itself. Audio comes with a
    transcript (already in the user text); video can be sampled with ffmpeg."""
    lines = ["Attachments (files uploaded from the phone; read them with the Read tool as needed):"]
    for a in attachments:
        if not a.get("path"):
            continue
        kind = a.get("kind") or "file"
        extra = ""
        if kind == "audio":
            extra = " (voice message; its transcript is the user's message text above)"
        elif kind == "video":
            extra = " (video; extract frames with `ffmpeg -i <path> -vf fps=1 frame_%03d.png` if you need to look at it)"
        lines.append(f"- [{kind}] {a['path']}{extra}")
    return "\n".join(lines)


def _trim(inp: dict | None, limit: int = 3000) -> dict:
    out: dict = {}
    for k, v in (inp or {}).items():
        if isinstance(v, str) and len(v) > limit:
            out[k] = v[:limit] + f"… (+{len(v) - limit})"
        else:
            out[k] = v
    return out


def _result_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for c in content:
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(c.get("text", ""))
    return "\n".join(parts)
