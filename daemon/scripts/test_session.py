#!/usr/bin/env python3
"""Settings a chat changes must reach the next turn. No model turns, no network.

    python scripts/test_session.py

Two things used to go wrong, and both looked the same from the phone: the chat
said the new setting was saved and then kept behaving like the old one.

  1. `chat.update` only rebuilt the provider for a hand-written list of fields,
     and `account_id` was not on it — so switching account changed nothing.
  2. `reconfigure()` returned early while a turn was running and left no trace,
     so a change made while the model was answering was lost for good.
"""
from __future__ import annotations

import asyncio
import inspect
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat.config import Config                       # noqa: E402
from remote_ai_chat.db import DB                               # noqa: E402
from remote_ai_chat.providers.base import ProviderConfig, TurnResult  # noqa: E402
from remote_ai_chat.providers.claude import ClaudeProvider     # noqa: E402
from remote_ai_chat.server import Server                        # noqa: E402
from remote_ai_chat.session import PROVIDER_FIELDS, ChatSession  # noqa: E402

failures: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}{'' if ok else f'  — {detail}'}")
    if not ok:
        failures.append(label)


class FakeProvider:
    """Stands in for a connected CLI. Records the config it was built with."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.closed = False
        self.gate: asyncio.Event | None = None
        self.prompts: list[str] = []

    async def run(self, prompt, attachments=None):
        if self.gate is not None:
            await self.gate.wait()
        self.prompts.append(prompt)
        return TurnResult(session_id="sess-1", cost_usd=None, usage=None,
                          duration_ms=1, num_turns=1)

    def has_pending(self):
        # A real provider answers this from its reader queue; this one is never
        # spoken to unasked.
        return False

    async def interrupt(self):
        pass

    async def close(self):
        self.closed = True


def make_session(db, chat):
    built: list[FakeProvider] = []

    async def broadcast(_ev):
        pass

    async def notify(_kind, _chat):
        pass

    s = ChatSession(chat, db, Config(), broadcast, notify)

    def fake_make_provider(c):
        # Same read of the row the real one does, so a stale rebuild shows up.
        p = FakeProvider(type("C", (), {
            "perm_mode": c["perm_mode"], "model": c["model"],
            "account_id": c.get("account_id"),
        })())
        built.append(p)
        return p

    s._make_provider = fake_make_provider
    return s, built


async def turn(s, text="hi"):
    await s.send(text, None)
    await s.running


async def scenario_idle(db):
    print("\nchanging a setting between turns")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    s, built = make_session(db, chat)
    await turn(s)
    check(len(built) == 1 and built[0].cfg.perm_mode == "ask", "first turn uses the saved mode")

    db.update_chat(chat["id"], perm_mode="bypass")
    await s.reconfigure()
    check(built[0].closed, "the old provider is closed")
    await turn(s)
    check(len(built) == 2 and built[1].cfg.perm_mode == "bypass",
          "the next turn runs with the new mode",
          f"built={len(built)} mode={built[-1].cfg.perm_mode}")


async def scenario_mid_turn(db):
    print("\nchanging a setting while the model is answering")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    s, built = make_session(db, chat)

    gate = asyncio.Event()
    orig = s._make_provider

    def gated(c):
        p = orig(c)
        p.gate = gate
        return p

    s._make_provider = gated
    await s.send("long one", None)
    check(s.is_busy(), "the turn is in flight")

    db.update_chat(chat["id"], perm_mode="bypass", account_id="acct-2")
    await s.reconfigure()
    check(s.is_busy(), "the running turn is not torn down under it")
    check(s.dirty, "the change is remembered instead of dropped")

    gate.set()
    await s.running
    s._make_provider = orig
    await turn(s)
    check(len(built) == 2, "the next turn builds a fresh provider", f"built={len(built)}")
    check(built[-1].cfg.perm_mode == "bypass" and built[-1].cfg.account_id == "acct-2",
          "and it carries the setting changed mid-turn",
          f"mode={built[-1].cfg.perm_mode} account={built[-1].cfg.account_id}")
    check(not s.dirty, "the flag is cleared once applied")


async def scenario_queue(db):
    """A message typed while the model is answering.

    The phone used to be told "busy", and the composer swapped its send button
    for a stop button — so the only way to add a thought to a running turn was
    to kill the turn. Nothing about that is necessary: the message can simply
    wait its turn, which is what a person means when they keep typing.
    """
    print("\nsomething typed while the model is answering waits its turn")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    s, built = make_session(db, chat)
    seen: list[dict] = []

    async def record(ev):
        seen.append(ev)

    s.broadcast = record
    dones = []
    s.notify = lambda kind, c: _noop(dones.append(kind))

    gate = asyncio.Event()
    orig = s._make_provider
    s._make_provider = lambda c: _gated(orig(c), gate)

    queued = await s.send("first", None)
    check(not queued and s.is_busy(), "the first message starts a turn")
    check(await s.send("second", None), "one sent mid-turn is queued, not refused")
    await s.send("third", None)
    check(len(s.queued) == 2, "both wait in line", f"queued={len(s.queued)}")
    check(sum(e["event"] == "message.user" for e in seen) == 3,
          "and all three show up on the phone right away")

    gate.set()
    await s.running
    check(built[0].prompts == ["first", "second", "third"],
          "the queue drains in order, on one provider", f"{[p.prompts for p in built]}")
    check(sum(e["event"] == "turn.done" for e in seen) == 3, "each one is a turn of its own")
    check(dones == ["done"], "and only the last one says the chat is done",
          f"notifies={dones}")
    check(not s.queued and db.get_chat(chat["id"])["status"] == "idle",
          "the chat lands idle once the line is empty")


async def scenario_queue_interrupt(db):
    print("\nstopping a turn drops what was waiting behind it")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    s, built = make_session(db, chat)
    gate = asyncio.Event()
    orig = s._make_provider
    s._make_provider = lambda c: _gated(orig(c), gate)

    await s.send("first", None)
    await s.send("second", None)
    check(len(s.queued) == 1, "the second one is waiting")
    await s.interrupt()
    check(not s.queued, "stopping clears the line")
    gate.set()
    await s.running
    check(built[0].prompts == ["first"],
          "what was waiting never reaches the agent", f"{built[0].prompts}")
    check(db.get_chat(chat["id"])["status"] == "idle", "and the chat is idle")


def _gated(p, gate):
    p.gate = gate
    return p


async def _noop(_=None):
    return None


async def scenario_perm_modes():
    """What each permission mode actually interrupts.

    "bypass" is chosen by somebody who does not want to be asked, and it used
    to ask anyway for anything the destructive list matched — a `tail` of the
    daemon's own log woke the phone up with a DANGEROUS COMMAND card. The list
    still guards the modes that mean "ask me": bypass answers for itself.
    """
    print("\npermission modes decide who is interrupted")
    LOG_TAIL = "tail -n 40 ~/.remote-ai-chat/logs/daemon.log"   # on the list
    ORDINARY = "ls -la /tmp"                                    # on nobody's list
    NASTY = "sudo rm -rf /var/tmp"                              # on every list

    async def run(mode: str, cmd: str) -> tuple[bool, bool, str | None]:
        """(was asked, hook installed, decision) for one command in one mode."""
        asked = False

        async def approval(tool, tool_input, reason):
            nonlocal asked
            asked = True
            return "allow"

        async def emit(*a, **kw):
            pass

        cfg = ProviderConfig(model="opus", effort=None, perm_mode=mode,
                             cwd=str(Path.home()), session_id=None)
        prov = ClaudeProvider(cfg, emit, approval)
        out = await prov._pre_tool_hook({"tool_name": "Bash", "tool_input": {"command": cmd}}, None, None)
        installed = bool(getattr(prov._options(), "hooks", None))
        decision = ((out.get("hookSpecificOutput") or {}).get("permissionDecision")) if out else None
        return asked, installed, decision

    asked, installed, decision = await run("bypass", LOG_TAIL)
    check(not asked, "bypass does not ask about reading the daemon's log")
    check(not installed, "bypass installs no pre-tool hook at all")
    check(decision is None, "bypass leaves the decision to the tool", f"decision={decision}")
    asked, _, _ = await run("bypass", NASTY)
    check(not asked, "bypass does not ask about sudo rm -rf either")

    asked, installed, _ = await run("ask", ORDINARY)
    check(asked, "ask asks about an ordinary command")
    check(installed, "ask installs the pre-tool hook")

    asked, _, _ = await run("accept-edits", ORDINARY)
    check(not asked, "accept-edits lets an ordinary command through")
    asked, _, decision = await run("accept-edits", NASTY)
    check(asked, "accept-edits still asks about sudo rm -rf")
    check(decision == "allow", "an approved command comes back allowed", f"decision={decision}")


def scenario_coverage():
    print("\nevery setting the provider reads can be changed")
    src = inspect.getsource(ChatSession._make_provider)
    # resolve_account/agent_prompt take the whole row; they key off account_id
    # and agent_id, which the same source names outright.
    read = set(re.findall(r'chat(?:\.get)?[\[\(]"([a-z_]+)"', src))
    missing = read - PROVIDER_FIELDS
    check(not missing, "PROVIDER_FIELDS covers what _make_provider reads",
          f"missing: {sorted(missing)}")
    stale = PROVIDER_FIELDS - read
    check(not stale, "PROVIDER_FIELDS has nothing _make_provider ignores",
          f"unused: {sorted(stale)}")
    check("account_id" in PROVIDER_FIELDS, "switching account rebuilds the provider")


async def scenario_update_routing(db):
    """The real `chat.update` path, not just the constant it should consult.

    Driven through the unbound handler with a stub host, so the routing runs
    without standing up a whole server. This is the check that would have caught
    `account_id` missing from the rebuild list: the phone sends that field on its
    own when you switch account, so a list that omits it rebuilds nothing.
    """
    print("\nchat.update rebuilds the session for a settings change")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    s, _built = make_session(db, chat)
    calls: list[int] = []
    s.reconfigure = lambda: (calls.append(1), asyncio.sleep(0))[1]

    class Host:
        pass

    host = Host()
    host.db = db
    host.sessions = type("S", (), {"peek": staticmethod(lambda _cid: s)})()
    host._account = lambda *a, **k: None
    host.broadcast = lambda _ev: asyncio.sleep(0)
    host.policy = type("P", (), {"is_allowed_cwd": staticmethod(lambda _p: True)})()

    for field, value in (("account_id", "acct-2"), ("perm_mode", "bypass"),
                         ("max_turns", 5), ("max_budget_usd", 2.5)):
        calls.clear()
        await Server.h_chat_update(host, None, {"chat_id": chat["id"], field: value})
        check(len(calls) == 1, f"{field} triggers a rebuild", f"reconfigure called {len(calls)}x")

    calls.clear()
    await Server.h_chat_update(host, None, {"chat_id": chat["id"], "title": "renamed"})
    check(not calls, "a rename does not tear the session down")


async def scenario_dropped_session(db):
    """A chat whose CLI session was dropped gets its own history back.

    Switching account clears the resume id — it belongs to the account that is
    gone. The chat on the phone still shows everything that came before, so the
    next turn opens a session that knows none of it while the user is looking at
    all of it. A "carry on" then has nothing to carry on from, and the model
    fills the gap from the tool's transcript folder, which is keyed by working
    folder rather than by chat: the newest session sitting in there belongs to
    whichever other chat was last opened on that folder. That is the whole bug —
    one chat answered as though it were another.
    """
    print("\na session opened without a resume id is told what it missed")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp")
    cid = chat["id"]

    s, built = make_session(db, chat)
    await turn(s, "first question")
    check("[Remote AI Chat]" not in built[0].prompts[0],
          "a brand new chat gets no recap")
    check(db.get_chat(cid)["provider_session_id"] == "sess-1",
          "the turn records the resume id")

    # A second turn resumes, so there is nothing to catch up on.
    s2, built2 = make_session(db, db.get_chat(cid))
    await turn(s2, "second question")
    check("[Remote AI Chat]" not in built2[0].prompts[0],
          "a resumed session is not handed the history it already has")

    # Now the account changes: the resume id goes, the chat history stays.
    db.update_chat(cid, account_id="acct-2", provider_session_id=None)
    s3, built3 = make_session(db, db.get_chat(cid))
    await turn(s3, "Devam")
    sent = built3[0].prompts[0]
    check("[Remote AI Chat]" in sent, "a dropped session is handed the chat's history")
    check("first question" in sent and "second question" in sent,
          "the history is this chat's own, both turns of it")
    check(sent.count("Devam") == 1, "the new message is not quoted back as history")
    check(sent.endswith("Devam"), "and it still ends with what the user actually typed")

    # The catch-up is a one-off: the turn that follows resumes normally.
    await turn(s3, "and now?")
    check("[Remote AI Chat]" not in built3[0].prompts[1],
          "the next turn on the same session gets no second recap")


async def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        db = DB(Path(tmp) / "test.sqlite")
        await scenario_idle(db)
        await scenario_mid_turn(db)
        await scenario_update_routing(db)
        await scenario_dropped_session(db)
        await scenario_queue(db)
        await scenario_queue_interrupt(db)
        await scenario_perm_modes()
        scenario_coverage()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
