#!/usr/bin/env python3
"""What the model writes must reach the phone in one piece. No turns, no network.

    python scripts/test_stream.py

The transcript used to come out shredded: a sentence would stop mid-word, a tool
card would sit in the gap, and the rest of the word would open the next bubble
("...editoryal t" | Bash | "asarım"). Nothing was lost, but it was unreadable.

The cause is that `receive_response()` can hand over a parsed AssistantMessage —
tool call included — before the raw text deltas behind it have all arrived. The
old loop treated a tool call as proof that the text in front of it was finished,
and cut it wherever the stream happened to be.

The rule now: a text block is whole only at `content_block_stop`, and tool cards
wait behind the text they interrupt.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from claude_agent_sdk.types import (                            # noqa: E402
    AssistantMessage, ResultMessage, StreamEvent, TextBlock, ToolUseBlock,
)

from remote_ai_chat.providers.base import ProviderConfig        # noqa: E402
from remote_ai_chat.providers.claude import ClaudeProvider      # noqa: E402

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        failures += 1


# ── a scripted CLI ────────────────────────────────────────────────────────────

def delta(text: str) -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event={
        "type": "content_block_delta", "delta": {"type": "text_delta", "text": text}})


def block_start(kind: str = "text") -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event={
        "type": "content_block_start", "content_block": {"type": kind}})


def block_stop() -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event={"type": "content_block_stop"})


def msg_start() -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event={"type": "message_start"})


def assistant(*blocks) -> AssistantMessage:
    return AssistantMessage(content=list(blocks), model="claude-opus-5")


def result() -> ResultMessage:
    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id="s", total_cost_usd=0.0, usage={})


class FakeClient:
    """Replays a fixed list of SDK messages, the way the CLI would."""

    def __init__(self, script: list) -> None:
        self.script = script

    async def query(self, prompt) -> None:  # noqa: ANN001
        return None

    async def receive_messages(self):
        for msg in self.script:
            yield msg


class LiveClient:
    """A CLI that talks when it feels like it, not only when asked."""

    def __init__(self) -> None:
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.queries: list[str] = []

    def say(self, *msgs) -> None:
        for m in msgs:
            self.inbox.put_nowait(m)

    async def query(self, prompt) -> None:  # noqa: ANN001
        self.queries.append(prompt)

    async def receive_messages(self):
        while True:
            yield await self.inbox.get()


async def run(script: list) -> list[dict]:
    """Drive one turn through the real stream loop and collect what it emitted."""
    seen: list[dict] = []

    async def emit(event: str, data: dict, persist: bool) -> None:
        if persist:
            seen.append({"event": event, **data})

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = ProviderConfig(model="opus", effort=None, perm_mode="bypass",
                         cwd=str(Path.home()), session_id=None)
    p = ClaudeProvider(cfg, emit, approval)
    fake = FakeClient(script)               # the loop never builds a real one
    p._client = fake
    p._reader = asyncio.create_task(p._read_stream(fake))
    try:
        await p.run("hi")
    finally:
        p._reader.cancel()
    return seen


def texts(seen: list[dict]) -> list[str]:
    return [e["text"] for e in seen if e["event"] == "message.assistant"]


def kinds(seen: list[dict]) -> list[str]:
    return [e["event"] for e in seen]


# ── scenarios ─────────────────────────────────────────────────────────────────

async def scenario_tool_arrives_early() -> None:
    """The exact shape that shredded the transcript: the AssistantMessage lands
    between two deltas of the text block it belongs to."""
    print("a tool call that overtakes the text it follows")
    sentence = "Üçü de paralel çalışıyor, lacivert/turuncu editoryal tasarım."
    head, tail = sentence[:45], sentence[45:]
    seen = await run([
        msg_start(), block_start(), delta(head),
        # early: the deltas for `tail` have not arrived yet
        assistant(TextBlock(text=sentence), ToolUseBlock(id="t1", name="Bash", input={"command": "ls"})),
        delta(tail), block_stop(),
        result(),
    ])
    got = texts(seen)
    check(got == [sentence], "the sentence arrives whole", f"got={got!r}")
    check(len(got) == 1, "and as one message, not two", f"n={len(got)}")
    check(kinds(seen) == ["message.assistant", "tool.use"],
          "the tool card follows the text it interrupted", f"got={kinds(seen)}")


async def scenario_ordinary_turn() -> None:
    """Text, tool, more text — nothing clever, and still in order."""
    print("\ntext, then a tool, then more text")
    seen = await run([
        msg_start(), block_start(), delta("Bakıyorum."), block_stop(),
        assistant(TextBlock(text="Bakıyorum."), ToolUseBlock(id="t1", name="Bash", input={"command": "ls"})),
        msg_start(), block_start(), delta("Buldum."), block_stop(),
        assistant(TextBlock(text="Buldum.")),
        result(),
    ])
    check(texts(seen) == ["Bakıyorum.", "Buldum."], "both messages land", f"got={texts(seen)!r}")
    check(kinds(seen) == ["message.assistant", "tool.use", "message.assistant"],
          "in the order the model wrote them", f"got={kinds(seen)}")


async def scenario_no_deltas() -> None:
    """Some messages never stream: the whole text shows up on the AssistantMessage."""
    print("\na message that never streamed a delta")
    seen = await run([
        msg_start(),
        assistant(TextBlock(text="Tek parça."), ToolUseBlock(id="t1", name="Bash", input={"command": "ls"})),
        result(),
    ])
    check(texts(seen) == ["Tek parça."], "the fallback still delivers it once", f"got={texts(seen)!r}")
    check(kinds(seen).count("message.assistant") == 1, "and exactly once, not twice",
          f"got={kinds(seen)}")


async def scenario_result_before_stop() -> None:
    """A tool that answers before the stream closes the text must still have a card."""
    print("\na tool result that beats content_block_stop")
    from claude_agent_sdk.types import ToolResultBlock, UserMessage
    seen = await run([
        msg_start(), block_start(), delta("Çalıştırıyorum."),
        assistant(TextBlock(text="Çalıştırıyorum."), ToolUseBlock(id="t1", name="Bash", input={"command": "ls"})),
        UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok")]),
        block_stop(),
        result(),
    ])
    order = kinds(seen)
    check("tool.use" in order and "tool.result" in order, "both the call and its answer are there")
    check(order.index("tool.use") < order.index("tool.result"),
          "the call is never reported after its own answer", f"got={order}")
    check(texts(seen) == ["Çalıştırıyorum."], "and the text is still whole", f"got={texts(seen)!r}")


async def scenario_multiple_tools() -> None:
    """Two calls in one message keep their order behind the same text."""
    print("\ntwo tool calls in one message")
    seen = await run([
        msg_start(), block_start(), delta("İkisini birden."),
        assistant(TextBlock(text="İkisini birden."),
                  ToolUseBlock(id="t1", name="Bash", input={"command": "a"}),
                  ToolUseBlock(id="t2", name="Bash", input={"command": "b"})),
        block_stop(),
        result(),
    ])
    ids = [e["id"] for e in seen if e["event"] == "tool.use"]
    check(ids == ["t1", "t2"], "both cards, in the order they were called", f"got={ids}")
    check(texts(seen) == ["İkisini birden."], "text unaffected", f"got={texts(seen)!r}")


async def scenario_unasked_turn() -> None:
    """The model speaks with no question in front of it.

    A background agent finishing hands the model a notification and it answers.
    Nobody asked, so there was no turn reading the stream, and the SDK parked
    the answer in its buffer. The next question then dragged that answer out
    under itself and ended on the old turn's ResultMessage — so every reply
    from then on arrived one question late, permanently. That is what the phone
    kept showing: "I send a message and the answer to the previous one appears."
    """
    print("\na turn the model started on its own")
    seen: list[dict] = []

    async def emit(event: str, data: dict, persist: bool) -> None:
        if persist:
            seen.append({"event": event, **data})

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = ProviderConfig(model="opus", effort=None, perm_mode="bypass",
                         cwd=str(Path.home()), session_id=None)
    p = ClaudeProvider(cfg, emit, approval)
    cli = LiveClient()
    p._client = cli
    p._reader = asyncio.create_task(p._read_stream(cli))

    opened: list[int] = []

    async def on_idle() -> None:
        opened.append(1)
        await p.run_continuation()

    p.on_idle_output = on_idle
    try:
        # nobody asked; the agent's notification is answered anyway
        cli.say(msg_start(), block_start(), delta("Arka plan bitti."), block_stop(),
                assistant(TextBlock(text="Arka plan bitti.")), result())
        for _ in range(200):                     # let the reader and the turn run
            await asyncio.sleep(0)
        check(opened == [1], "a turn is opened for it", f"opened={opened}")
        check(texts(seen) == ["Arka plan bitti."],
              "and it is delivered before anything else is asked", f"got={texts(seen)!r}")
        check(cli.queries == [], "without pretending anyone asked", f"got={cli.queries}")

        # now a real question: it must get its own answer, not the one above
        seen.clear()
        turn = asyncio.create_task(p.run("yeni soru"))
        for _ in range(50):
            await asyncio.sleep(0)
        cli.say(msg_start(), block_start(), delta("Yeni cevap."), block_stop(),
                assistant(TextBlock(text="Yeni cevap.")), result())
        await asyncio.wait_for(turn, timeout=5)
        check(texts(seen) == ["Yeni cevap."],
              "the question gets the answer to itself", f"got={texts(seen)!r}")
    finally:
        p._reader.cancel()


async def scenario_housekeeping_is_not_a_turn() -> None:
    """What follows a finished turn is not the model speaking.

    A turn ends at its ResultMessage, but the CLI keeps talking after it: the
    tail stream events of the reply, hook events, rate-limit notices. All of it
    lands in the same inbox. While `has_pending()` meant "the inbox is not
    empty", that leftover read as speech, the session opened a continuation
    turn for it, and that turn waited on a ResultMessage nobody was going to
    send. The chat stayed busy for good — every message typed afterwards was
    queued behind a turn that could never end, which is what the phone saw:
    "chats are extremely slow, hanging, not working".
    """
    print("\nhousekeeping after a turn is not a turn")

    async def emit(event: str, data: dict, persist: bool) -> None:
        return None

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = ProviderConfig(model="opus", effort=None, perm_mode="bypass",
                         cwd=str(Path.home()), session_id=None)
    p = ClaudeProvider(cfg, emit, approval)
    cli = LiveClient()
    p._client = cli
    p._reader = asyncio.create_task(p._read_stream(cli))
    try:
        cli.say(msg_start(), block_start(), delta("Bitti."), block_stop(),
                assistant(TextBlock(text="Bitti.")), result())
        await p.run("hi")

        # the tail the CLI sends once the turn is over
        cli.say(block_stop(), StreamEvent(uuid="u", session_id="s",
                                          event={"type": "message_stop"}))
        await asyncio.sleep(0.05)
        check(not p.has_pending(), "leftover housekeeping is not pending",
              f"spoken={p._spoken}")

        # ...and real speech still is
        cli.say(assistant(TextBlock(text="Arka plan ajanı bitti.")))
        await asyncio.sleep(0.05)
        check(p.has_pending(), "unasked speech is still pending")
    finally:
        p._reader.cancel()


async def scenario_background_agent_is_not_a_turn() -> None:
    """A helper the turn launched is not the model speaking unasked.

    This is what actually wedged the chats. A turn calls the Agent tool, the
    turn ends, and the helper keeps talking for minutes afterwards — on this
    same stream, tagged with the tool call that spawned it, at exactly the time
    the chat has no turn in flight. The drain loop already skips anything
    carrying a `parent_tool_use_id`; `_starts_a_turn` did not. So the helper's
    chatter counted as speech, a continuation turn was opened for it, and that
    turn then skipped every message it had been opened for and waited on a
    ResultMessage belonging to no one. The chat never came back to idle and
    everything typed afterwards was queued behind it.

    Note the idle ceiling cannot cover this: a talkative helper resets the
    clock with every message. The filter is the fix; the ceiling is only a
    backstop for a turn that goes silent.
    """
    print("\na background agent's chatter is not a turn")

    async def emit(event: str, data: dict, persist: bool) -> None:
        return None

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = ProviderConfig(model="opus", effort=None, perm_mode="bypass",
                         cwd=str(Path.home()), session_id=None)
    p = ClaudeProvider(cfg, emit, approval)
    cli = LiveClient()
    p._client = cli
    p._reader = asyncio.create_task(p._read_stream(cli))

    opened: list[int] = []

    async def on_idle() -> None:
        opened.append(1)

    p.on_idle_output = on_idle
    try:
        cli.say(msg_start(), block_start(), delta("Ajanı başlattım."), block_stop(),
                assistant(TextBlock(text="Ajanı başlattım.")), result())
        await p.run("arka planda bir ajan çalıştır")

        # the helper works on, long after the turn that launched it ended
        helper = "toolu_bg1"
        cli.say(
            StreamEvent(uuid="u", session_id="s", parent_tool_use_id=helper,
                        event={"type": "message_start"}),
            AssistantMessage(content=[TextBlock(text="Now let me check both files")],
                             model="claude-opus-5", parent_tool_use_id=helper),
        )
        await asyncio.sleep(0.05)
        check(not p.has_pending(), "a helper's chatter is not pending",
              f"_spoken={p._spoken}")
        check(not opened, "and opens no turn of its own", f"opened={len(opened)}")

        # the model itself, speaking unasked, still does
        cli.say(assistant(TextBlock(text="Ajan bitti, sonuç şu.")))
        await asyncio.sleep(0.05)
        check(p.has_pending(), "the model speaking unasked still is")
        check(len(opened) == 1, "and that one does open a turn", f"opened={len(opened)}")
    finally:
        p._reader.cancel()


async def main() -> None:
    await scenario_background_agent_is_not_a_turn()
    await scenario_housekeeping_is_not_a_turn()
    await scenario_unasked_turn()
    await scenario_tool_arrives_early()
    await scenario_ordinary_turn()
    await scenario_no_deltas()
    await scenario_result_before_stop()
    await scenario_multiple_tools()
    print("\nall checks passed" if not failures else f"\n{failures} check(s) failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
