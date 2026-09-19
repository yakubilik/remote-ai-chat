#!/usr/bin/env python3
"""Several sign-ins of one tool, driven as one. No model turns, no network.

    python scripts/test_pool.py

Two halves, and they fail differently:

  1. Reading a plan. A window at 99% blocks the account; the same reading
     after the window has reset does not, and an account with pay-as-you-go
     on is not blocked at all unless the user said never to use it. Get this
     wrong in the safe direction and the pool never moves; get it wrong the
     other way and it moves every chat off a perfectly good account.
  2. Moving a chat. Between turns it is free. Mid-turn it means interrupting,
     rebinding, and handing the next sign-in the chat's own transcript —
     without losing what was queued behind the turn and without telling the
     phone the turn is done when it is still going.
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat.accounts import Account                    # noqa: E402
from remote_ai_chat.config import Config                       # noqa: E402
from remote_ai_chat.db import DB                               # noqa: E402
from remote_ai_chat.pool import Pool, Settings                 # noqa: E402
from remote_ai_chat.providers.base import TurnResult           # noqa: E402
from remote_ai_chat.server import Server                       # noqa: E402
from remote_ai_chat.session import HANDOVER_NOTE, ChatSession  # noqa: E402

failures: list[str] = []
HOUR = 3600


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}{'' if ok else f'  — {detail}'}")
    if not ok:
        failures.append(label)


# ── reading a plan ─────────────────────────────────────────────────────────
def window(name: str, util: float, *, resets_in: float = HOUR, status: str = "allowed",
           overage: str | None = None, at: float | None = None) -> dict:
    now = time.time()
    row = {"window": name, "status": status, "utilization": util,
           "resets_at": now + resets_in, "at": at if at is not None else now}
    if overage is not None:
        row["overage_status"] = overage
    return row


def make_pool(limits: dict[str, list[dict]], **settings) -> Pool:
    accounts = {
        "default-claude": Account(id="default-claude", provider="claude", label="this computer"),
        "acct-2": Account(id="acct-2", provider="claude", label="second", home="/tmp/a2",
                          created_at=2),
        "acct-3": Account(id="acct-3", provider="claude", label="third", home="/tmp/a3",
                          created_at=3),
    }
    return Pool(Settings.from_dict(settings), lambda: accounts, lambda k: limits.get(k, []))


def scenario_reading() -> None:
    print("\nreading a plan")

    p = make_pool({"acct-2": [window("five_hour", 0.5)]})
    check(not p.state("acct-2", "claude").blocked, "half a window is not a limit")

    p = make_pool({"acct-2": [window("five_hour", 0.99)]})
    st = p.state("acct-2", "claude")
    check(st.blocked and st.window == "five_hour", "99% of the five-hour window blocks",
          f"blocked={st.blocked} window={st.window}")

    p = make_pool({"acct-2": [window("seven_day", 0.4), window("five_hour", 1.0,
                                                               status="rejected")]})
    check(p.state("acct-2", "claude").blocked, "one full window is enough")

    # The same reading, taken before the window it describes rolled over.
    p = make_pool({"acct-2": [window("five_hour", 1.0, resets_in=-60, status="rejected")]})
    check(not p.state("acct-2", "claude").blocked,
          "a window that has since reset stops counting")

    # Percentages instead of fractions — the CLI has reported both.
    p = make_pool({"acct-2": [window("five_hour", 99.0)]})
    check(p.state("acct-2", "claude").blocked, "99 reads as 99%, not as 9900%")

    # The windows are not alike, so they do not share a line. The five-hour one
    # refills several times a day — stopping early there costs a couple of
    # hours; 5% of a weekly window is most of a working day.
    both = {"acct-2": [window("five_hour", 0.96), window("seven_day", 0.96)]}
    st = make_pool(both).state("acct-2", "claude")
    check(st.blocked and st.window == "five_hour",
          "96% is over the five-hour line", f"blocked={st.blocked} window={st.window}")
    check(not make_pool({"acct-2": [window("seven_day", 0.96)]}).state("acct-2", "claude").blocked,
          "…and the same number on a weekly window is nowhere near its own")
    check(make_pool({"acct-2": [window("seven_day", 0.995)]}).state("acct-2", "claude").blocked,
          "the weekly line is 99%")
    check(make_pool({"acct-2": [window("seven_day_opus", 0.995)]}).state("acct-2", "claude").blocked,
          "a window nobody named falls back to the general line")
    check(not make_pool({"acct-2": [window("five_hour", 0.96)]},
                        thresholds={"five_hour": 0.99}).state("acct-2", "claude").blocked,
          "and the lines are the user's to move")

    p = make_pool({"acct-2": []})
    st = p.state("acct-2", "claude")
    check(st.unknown and not st.blocked, "an account nobody has run is not assumed full")

    # Pay-as-you-go carries the account past the plan.
    rows = [window("five_hour", 1.0, status="rejected", overage="allowed")]
    st = make_pool({"acct-2": rows}).state("acct-2", "claude")
    check(not st.blocked and st.on_overage, "overage keeps a spent plan in play",
          f"blocked={st.blocked} on_overage={st.on_overage}")

    st = make_pool({"acct-2": rows}, use_overage="never").state("acct-2", "claude")
    check(st.blocked, "…unless the user said never to spend it")

    # Overage that is switched off on the account's own billing page.
    rows = [dict(window("five_hour", 1.0, status="rejected", overage="rejected"),
                 overage_disabled_reason="not_enabled")]
    check(make_pool({"acct-2": rows}).state("acct-2", "claude").blocked,
          "overage that is not available rescues nothing")

    # The allowance itself running out.
    rows = [window("five_hour", 1.0, status="rejected", overage="allowed"),
            window("overage", 1.0, status="rejected")]
    check(make_pool({"acct-2": rows}).state("acct-2", "claude").blocked,
          "a spent overage allowance is not a rescue either")


def scenario_never_spend() -> None:
    """`use_overage = "never"` is the setting with money behind it.

    The account is allowed to bill past its plan, and the user has said not to.
    There is no flag that makes the CLI refuse — extra usage is an account-level
    setting — so everything strict has to happen here, and late is the same as
    not at all.
    """
    print("\nnever spending past the plan")

    # Nothing about the windows is over the line, but the tool says paid usage
    # is covering sends *right now*. That is the trip wire.
    rows = [dict(window("five_hour", 0.4, overage="allowed"), is_using_overage=True)]
    st = make_pool({"acct-2": rows}, use_overage="never").state("acct-2", "claude")
    check(st.blocked and st.window == "overage",
          "money going out right now blocks, whatever the windows say",
          f"blocked={st.blocked} window={st.window}")
    check(st.spending, "and it is reported as spending, not merely full")

    st = make_pool({"acct-2": rows}).state("acct-2", "claude")
    check(not st.blocked and st.spending,
          "with overage allowed the same reading is shown but not acted on")

    # The flag stays set after the allowance itself is gone; the CLI's own note
    # says to read it with the status rather than alone.
    spent = [dict(window("five_hour", 0.4, overage="rejected"), is_using_overage=True)]
    check(not make_pool({"acct-2": spent}, use_overage="never").state("acct-2", "claude").spending,
          "a flag left set after the allowance ran out is not spending")

    # A margin the size of the coarsest reading this account has produced.
    # Nothing measured yet, so `reserve` stands in for a step.
    near = {"acct-2": [window("seven_day", 0.92)]}
    st = make_pool(near, use_overage="never", threshold=0.99, reserve=0.10).state("acct-2", "claude")
    check(st.blocked and st.margin == 0.10,
          "within one assumed step of the line counts as over it",
          f"blocked={st.blocked} margin={st.margin}")

    st = make_pool(near, threshold=0.99, reserve=0.10).state("acct-2", "claude")
    check(not st.blocked and st.margin == 0,
          "with overage allowed there is nothing to hold plan back against")

    # Once a real step has been seen, that is the margin — bigger or smaller.
    coarse = {"acct-2": [dict(window("seven_day", 0.80), step=0.22)]}
    st = make_pool(coarse, use_overage="never", threshold=0.99, reserve=0.10).state("acct-2", "claude")
    check(st.blocked and st.step == 0.22 and st.margin == 0.22,
          "a measured step wider than the guess widens the margin",
          f"blocked={st.blocked} step={st.step} margin={st.margin}")

    fine = {"acct-2": [dict(window("seven_day", 0.94), step=0.02)]}
    st = make_pool(fine, use_overage="never", threshold=0.99, reserve=0.10).state("acct-2", "claude")
    check(st.blocked, "…but a narrow one does not shrink it below the guess")
    check(st.margin == 0.10, "the guess is a floor, not a starting point", str(st.margin))

    # And the margin steers the choice, not just the refusal.
    p = make_pool({"default-claude": [window("seven_day", 0.95)],
                   "acct-2": [window("seven_day", 0.2)]},
                  use_overage="never", threshold=0.99, reserve=0.10)
    check(p.candidates("claude")[0] == "acct-2",
          "a sign-in inside the margin is not offered as somewhere to move to",
          str(p.candidates("claude")))

    # Per account: one sign-in spending past its plan, another never.
    both = {"default-claude": [dict(window("five_hour", 0.4, overage="allowed"),
                                    is_using_overage=True)],
            "acct-2": [dict(window("five_hour", 0.4, overage="allowed"),
                            is_using_overage=True)]}
    p = make_pool(both, use_overage="account", overage_by_account={"acct-2": "never"})
    check(not p.state("default-claude", "claude").blocked,
          "the sign-in that is allowed to spend keeps going")
    check(p.state("acct-2", "claude").blocked,
          "the one that is not is stopped, on the same machine at the same moment")
    check(p.state("acct-2", "claude").strict and not p.state("default-claude", "claude").strict,
          "and each says which rule it is under")


def scenario_choosing() -> None:
    print("\nchoosing the next sign-in")

    p = make_pool({})
    check(p.order("claude")[0] == "default-claude",
          "with no order set, this computer's own sign-in goes first",
          str(p.order("claude")))

    p = make_pool({}, order={"claude": ["acct-3"]})
    check(p.order("claude") == ["acct-3", "default-claude", "acct-2"],
          "a configured order comes first, the rest keep their usual order",
          str(p.order("claude")))

    p = make_pool({"default-claude": [window("five_hour", 1.0, status="rejected")],
                   "acct-2": [window("five_hour", 0.2)],
                   "acct-3": [window("five_hour", 0.1)]})
    check(p.candidates("claude") == ["acct-2", "acct-3"],
          "the full account is skipped and the order of the rest is kept",
          str(p.candidates("claude")))
    check(p.candidates("claude", {"acct-2"}) == ["acct-3"], "an excluded account is skipped")

    # Measured beats unmeasured: a guess is worth less than a reading.
    p = make_pool({"default-claude": [window("five_hour", 1.0, status="rejected")],
                   "acct-3": [window("five_hour", 0.1)]})
    check(p.candidates("claude") == ["acct-3", "acct-2"],
          "an account with room ranks above one nothing is known about",
          str(p.candidates("claude")))

    p = make_pool({k: [window("five_hour", 1.0, status="rejected")]
                   for k in ("default-claude", "acct-2", "acct-3")})
    check(p.candidates("claude") == [], "when every plan is spent there is nowhere to go")


# ── moving a chat ──────────────────────────────────────────────────────────
class FakeProvider:
    """Stands in for a connected CLI. Records what it was built for and what
    it was asked, and can be held open so a turn is still running."""

    def __init__(self, account_id):
        self.account_id = account_id
        self.prompts: list[str] = []
        self.closed = False
        self.gate: asyncio.Event | None = None
        self.interrupted = False

    async def run(self, prompt, attachments=None):
        self.prompts.append(prompt)
        if self.gate is not None:
            await self.gate.wait()
        if self.interrupted:
            return TurnResult(session_id=None, cost_usd=None, usage=None, duration_ms=1,
                              num_turns=1, stop_reason="interrupted")
        return TurnResult(session_id="sess-" + (self.account_id or "default"), cost_usd=None,
                          usage=None, duration_ms=1, num_turns=1)

    def has_pending(self):
        return False

    async def interrupt(self):
        self.interrupted = True
        if self.gate is not None:
            self.gate.set()

    async def close(self):
        self.closed = True


def make_session(db, chat, pick=None, nxt=None):
    built: list[FakeProvider] = []
    events: list[tuple[str, dict]] = []
    notes: list[str] = []

    async def broadcast(ev):
        events.append((ev["event"], ev.get("data") or {}))

    async def notify(kind, _chat):
        notes.append(kind)

    s = ChatSession(chat, db, Config(), broadcast, notify)
    s.pool_pick = pick
    s.pool_next = nxt

    def fake_make_provider(c):
        p = FakeProvider(c.get("account_id"))
        built.append(p)
        return p

    s._make_provider = fake_make_provider
    return s, built, events, notes


async def scenario_between_turns(db) -> None:
    print("\nmoving a chat between turns")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp", account_id="acct-2")

    picked: list[dict] = []

    async def pick(c):
        picked.append(c)
        return "acct-3"

    s, built, events, _ = make_session(db, chat, pick)
    await s.send("hello", None)
    await s.running

    check(bool(picked), "the pool is asked before the turn opens")
    check(built[0].account_id == "acct-3", "the turn runs on the sign-in it chose",
          str(built[0].account_id))
    check(db.get_chat(chat["id"])["account_id"] == "acct-3", "the chat is rebound on disk")
    switched = [d for e, d in events if e == "account.switched"]
    check(len(switched) == 1 and switched[0]["from"] == "acct-2" and switched[0]["to"] == "acct-3",
          "the phone is told which sign-in it moved to", str(switched))

    # A second turn on an account that still has room changes nothing.
    async def stay(_c):
        return None

    s.pool_pick = stay
    await s.send("again", None)
    await s.running
    check(len([e for e, _ in events if e == "account.switched"]) == 1,
          "a chat with room left is not moved")


async def scenario_mid_turn(db) -> None:
    print("\nmoving a chat while the model is answering")
    chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                          perm_mode="ask", cwd="/tmp", account_id="acct-2")

    async def stay(_c):
        return None

    s, built, events, notes = make_session(db, chat, stay)
    gate = asyncio.Event()
    orig = s._make_provider

    def gated(c):
        p = orig(c)
        if len(built) == 1:          # only the first sign-in is held open
            p.gate = gate
        return p

    s._make_provider = gated
    await s.send("do the long thing", None)
    await asyncio.sleep(0)
    check(s.is_busy(), "the turn is in flight")

    # Something typed while the turn ran; it belongs to the chat, not to the
    # sign-in, and has to survive the move.
    await s.send("and this too", None)
    check(len(s.queued) == 1, "the second message is queued behind the turn")

    moved = await s.handover("acct-3")
    check(moved, "the pool can take a running turn off the account")
    await s.running

    check(len(built) >= 2 and built[1].account_id == "acct-3",
          "the turn reopens on the next sign-in", f"built={[b.account_id for b in built]}")
    check(built[0].closed, "the old sign-in's session is closed")
    check(HANDOVER_NOTE in (built[1].prompts[0] or ""),
          "the new session is told it walked into a turn already under way")
    check("do the long thing" in (built[1].prompts[0] or ""),
          "…and is handed the chat's own transcript to do it from")
    check(db.get_chat(chat["id"])["account_id"] == "acct-3", "the chat is rebound on disk")
    check(len(s.queued) == 0 and any("and this too" in (p or "") for p in built[-1].prompts),
          "what was queued behind the turn follows it across",
          f"queued={s.queued} prompts={[p[:40] for p in built[-1].prompts]}")

    switched = [d for e, d in events if e == "account.switched"]
    check(len(switched) == 1 and switched[0]["to"] == "acct-3", "the phone is told once",
          str(switched))
    check(not [e for e, _ in events if e == "turn.error"],
          "an interrupt asked for by the pool is not reported as a failure")
    check(notes.count("done") == 1,
          "only the real end of the work notifies; the handover does not",
          f"notifications={notes}")


# ── the daemon's own wiring ────────────────────────────────────────────────
def stub_host(db, accounts, sessions, **settings):
    """The half of the server the pool touches, and nothing else.

    Driven through the unbound handlers rather than a running daemon: what is
    worth checking here is the path from "a limit report arrived" to "that chat
    is now on another sign-in", and every hop of it belongs to Server.
    """
    class Host:
        pass

    host = Host()
    host.db = db
    host.limits = {}
    host.accounts = accounts
    host.sessions = type("S", (), {"sessions": sessions})()
    for name in ("_limit_rows", "_sessions_on", "_pool_next", "_pool_next_for",
                 "_pool_pick", "_pool_sweep", "_remember_limits"):
        setattr(host, name, getattr(Server, name).__get__(host))
    host._learn_steps = Server._learn_steps          # a staticmethod, not bound
    host.pool = Pool(Settings.from_dict({"enabled": True, **settings}),
                     lambda: accounts, host._limit_rows)
    return host


async def scenario_wiring(db) -> None:
    print("\nfrom a limit report to a chat on another sign-in")

    # The CLI is the only thing that knows whether a sign-in is still valid,
    # and asking it is a subprocess. Here it always says yes.
    import remote_ai_chat.server as server_mod
    real_refresh = server_mod.acct.refresh

    def signed_in(a):
        a.logged_in = True
        return a

    server_mod.acct.refresh = signed_in
    try:
        chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                              perm_mode="ask", cwd="/tmp", account_id="acct-2")
        pinned = db.create_chat(title="pinned", provider="claude", model="sonnet", effort=None,
                                perm_mode="ask", cwd="/tmp", account_id="acct-2", pool_pinned=1)

        async def stay(_c):
            return None

        accounts = {
            "default-claude": Account(id="default-claude", provider="claude", label="this computer"),
            "acct-2": Account(id="acct-2", provider="claude", label="second", home="/tmp/a2",
                              created_at=2),
            "acct-3": Account(id="acct-3", provider="claude", label="third", home="/tmp/a3",
                              created_at=3),
        }
        sessions: dict = {}
        # An explicit order, because "the next account" is only a sentence
        # worth testing when there is a list saying which one that is.
        host = stub_host(db, accounts, sessions,
                         order={"claude": ["acct-2", "acct-3", "default-claude"]})

        s, built, events, _ = make_session(db, chat, stay, host._pool_next_for)
        s2, built2, _e2, _ = make_session(db, pinned, stay, host._pool_next_for)
        sessions.update({chat["id"]: s, pinned["id"]: s2})
        gate = asyncio.Event()
        for sess, holder in ((s, built), (s2, built2)):
            orig = sess._make_provider

            def gated(c, _orig=orig):
                p = _orig(c)
                p.gate = gate
                return p

            sess._make_provider = gated

        await s.send("long one", None)
        await s2.send("long one too", None)
        await asyncio.sleep(0)

        # The report the CLI sends on every turn, this time with the five-hour
        # window spent. It arrives on one chat; it is about the account.
        key = host._remember_limits({
            "event": "limits", "chat_id": chat["id"],
            "data": {"window": "five_hour", "status": "rejected", "utilization": 1.0,
                     "resets_at": time.time() + 2 * HOUR,
                     "windows": [{"window": "five_hour", "status": "rejected",
                                  "utilization": 1.0, "resets_at": time.time() + 2 * HOUR}]},
        })
        check(key == "acct-2", "the report is filed under the account that made it", str(key))
        check(host.pool.state("acct-2", "claude").blocked, "and it reads as a spent plan")

        await host._pool_sweep("acct-2")
        check(s._handover is not None, "the running chat is taken off the account")
        check(s2._handover is None, "a chat pinned to its account is left where it is")

        gate.set()
        await s.running
        await s2.running
        check(db.get_chat(chat["id"])["account_id"] == "acct-3", "it lands on the next sign-in",
              str(db.get_chat(chat["id"])["account_id"]))
        check(db.get_chat(pinned["id"])["account_id"] == "acct-2", "the pinned chat did not move")

        # And the same decision, made before a turn rather than during one.
        idle = db.create_chat(title="idle", provider="claude", model="sonnet", effort=None,
                              perm_mode="ask", cwd="/tmp", account_id="acct-2")
        check(await host._pool_pick(db.get_chat(idle["id"])) == "acct-3",
              "a chat about to start on the spent account is moved first")
        idle_pinned = db.get_chat(pinned["id"])
        check(await host._pool_pick(idle_pinned) is None,
              "…and one pinned to its account is not")

        host.pool.settings.enabled = False
        check(await host._pool_pick(db.get_chat(idle["id"])) is None,
              "with the pool off nothing is moved at all")
    finally:
        server_mod.acct.refresh = real_refresh


def scenario_learning() -> None:
    """The daemon measures its own blind spot.

    It cannot see what happens between two reports, so it watches how far a
    window moves across one and keeps the worst. That number is the margin, and
    it is the only honest one available: no token accounting, no guess at what
    a turn costs — just a bound on the jump that has actually been observed.
    """
    print("\nlearning how coarse the readings are")

    slot: dict = {}

    def report(util):
        kept = [{"window": "five_hour", "utilization": util}]
        Server._learn_steps(slot, kept)
        for r in kept:
            slot["five_hour"] = r
        return slot["five_hour"].get("step")

    check(report(0.10) is None, "one reading teaches nothing")
    check(abs(report(0.14) - 0.04) < 1e-9, "two readings give a step",
          str(slot["five_hour"].get("step")))
    check(abs(report(0.35) - 0.21) < 1e-9, "a wider jump replaces it",
          str(slot["five_hour"].get("step")))
    check(abs(report(0.36) - 0.21) < 1e-9, "a narrower one does not",
          str(slot["five_hour"].get("step")))
    # A window rolling over is a drop, not a jump.
    check(abs(report(0.01) - 0.21) < 1e-9, "a window reset is not mistaken for a step",
          str(slot["five_hour"].get("step")))


async def scenario_stop_first(db) -> None:
    """The order of the two things the sweep does, which is the whole point.

    Choosing where a chat goes next costs a subprocess — `claude auth status`
    on the candidate. Doing that before the interrupt leaves the model
    generating for as long as it takes, on a plan that has already run out. On
    an account that bills past its plan, that is the money the user said not to
    spend, so the stop has to come first and the choosing after.
    """
    print("\nstopping comes before choosing")

    import remote_ai_chat.server as server_mod
    real_refresh = server_mod.acct.refresh
    order: list[str] = []

    def slow_refresh(a):
        order.append("choose")
        a.logged_in = True
        return a

    server_mod.acct.refresh = slow_refresh
    try:
        chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                              perm_mode="ask", cwd="/tmp", account_id="acct-2")

        async def stay(_c):
            return None

        accounts = {
            "acct-2": Account(id="acct-2", provider="claude", label="second", home="/tmp/a2",
                              created_at=2),
            "acct-3": Account(id="acct-3", provider="claude", label="third", home="/tmp/a3",
                              created_at=3),
        }
        sessions: dict = {}
        host = stub_host(db, accounts, sessions, use_overage="never",
                         order={"claude": ["acct-2", "acct-3"]})
        s, built, events, _ = make_session(db, chat, stay, host._pool_next_for)
        sessions[chat["id"]] = s

        gate = asyncio.Event()
        orig_make = s._make_provider

        def gated(c):
            p = orig_make(c)
            p.gate = gate
            real_interrupt = p.interrupt

            async def watched():
                order.append("stop")
                await real_interrupt()

            p.interrupt = watched
            return p

        s._make_provider = gated
        await s.send("long one", None)
        await asyncio.sleep(0)

        # Paid usage is covering sends this second — the hardest signal there is.
        host._remember_limits({
            "event": "limits", "chat_id": chat["id"],
            "data": {"window": "five_hour", "status": "allowed_warning", "utilization": 0.4,
                     "resets_at": time.time() + HOUR, "overage_status": "allowed",
                     "is_using_overage": True,
                     "windows": [{"window": "five_hour", "status": "allowed_warning",
                                  "utilization": 0.4, "resets_at": time.time() + HOUR}]},
        })
        check(host.pool.state("acct-2", "claude").blocked,
              "spending past the plan blocks the account at once")

        await host._pool_sweep("acct-2")
        gate.set()
        await s.running
        check(order[:1] == ["stop"],
              "the model is stopped before anything asks where it should go next",
              f"order={order}")
        check(db.get_chat(chat["id"])["account_id"] == "acct-3", "and it still moves")
    finally:
        server_mod.acct.refresh = real_refresh


async def scenario_nowhere_to_go(db) -> None:
    """Every sign-in spent. The turn stops rather than carrying on.

    Carrying on where it was would either be refused — costing a dead turn and
    a confusing chat — or, on a sign-in that can bill past its plan, be exactly
    the spending the pool was turned on to prevent.
    """
    print("\nwhen there is nowhere left to go")

    import remote_ai_chat.server as server_mod
    real_refresh = server_mod.acct.refresh
    server_mod.acct.refresh = lambda a: (setattr(a, "logged_in", True), a)[1]
    try:
        chat = db.create_chat(title="t", provider="claude", model="sonnet", effort=None,
                              perm_mode="ask", cwd="/tmp", account_id="acct-2")

        async def stay(_c):
            return None

        accounts = {
            "acct-2": Account(id="acct-2", provider="claude", label="second", home="/tmp/a2",
                              created_at=2),
            "acct-3": Account(id="acct-3", provider="claude", label="third", home="/tmp/a3",
                              created_at=3),
        }
        sessions: dict = {}
        host = stub_host(db, accounts, sessions, use_overage="never",
                         order={"claude": ["acct-2", "acct-3"]})
        s, built, events, notes = make_session(db, chat, stay, host._pool_next_for)
        sessions[chat["id"]] = s

        gate = asyncio.Event()
        orig_make = s._make_provider

        def gated(c):
            p = orig_make(c)
            p.gate = gate
            return p

        s._make_provider = gated
        await s.send("long one", None)
        await asyncio.sleep(0)
        await s.send("and this", None)

        for aid in ("acct-2", "acct-3"):
            host.limits[aid] = {"five_hour": {
                "window": "five_hour", "status": "rejected", "utilization": 1.0,
                "resets_at": time.time() + 2 * HOUR, "at": time.time()}}

        await host._pool_sweep("acct-2")
        gate.set()
        await s.running

        check(len(built) == 1, "no second session is opened", f"built={len(built)}")
        check(db.get_chat(chat["id"])["account_id"] == "acct-2", "the chat stays where it was")
        check(any(e == "pool.exhausted" for e, _ in events),
              "the reader is told every plan is spent", str([e for e, _ in events]))
        check(not s.queued, "nothing is left queued for a chat that cannot run it")
        check(db.get_chat(chat["id"])["status"] == "idle", "and the chat goes idle",
              db.get_chat(chat["id"])["status"])
    finally:
        server_mod.acct.refresh = real_refresh


async def main() -> None:
    scenario_reading()
    scenario_never_spend()
    scenario_learning()
    scenario_choosing()
    with tempfile.TemporaryDirectory() as tmp:
        db = DB(Path(tmp) / "db.sqlite")
        await scenario_between_turns(db)
        await scenario_mid_turn(db)
        await scenario_wiring(db)
        await scenario_stop_first(db)
        await scenario_nowhere_to_go(db)
    print()
    if failures:
        print(f"{len(failures)} failed: " + ", ".join(failures))
        sys.exit(1)
    print("all good")


if __name__ == "__main__":
    asyncio.run(main())
