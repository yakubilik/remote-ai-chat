"""The account pool: several sign-ins of one tool, driven as one.

A chat is bound to one account at a time, and that has to stay true — the CLI
session behind it lives in that account's config dir, and its transcript is
keyed there. What the pool adds is the right to change which one, without
anybody choosing, when the account a chat is on has run out of plan.

The daemon is the only place this can live. It is the one party that sees every
account's last limit report, every chat's binding, and every turn while it is
still running. The phone sees one chat; the pool sees the whole machine.

What the tool tells us, and when
--------------------------------
Claude Code reports its plan windows — `five_hour`, `seven_day`, the per-model
weeklies — only while a turn is running, and only for the account running it.
So the account in use is measured continuously and the other nine are a memory.
Two things keep that memory honest:

* a window whose `resets_at` has passed has rolled over since it was measured,
  whatever it said at the time, so it stops counting against the account;
* an account nobody has ever run is not assumed full. It is tried, and if the
  CLI refuses it the pool simply moves on to the next one.

Overage, and what "never" has to be worth
----------------------------------------
When pay-as-you-go is enabled the plan's windows filling up does not stop the
account — it keeps going and it costs money. That is a decision the user made
on their side, so by default the pool respects it and leaves such an account in
play.

`use_overage = "never"` is the other intent, and it is the one that has to be
airtight: treat the plan's limit as the limit, whatever the billing page
allows. Two things are worth being clear about.

* When extra usage is **disabled on the account**, nothing here is load-bearing.
  The platform refuses rather than bills, so a late move costs a dead turn and
  not a cent. The tool says so itself: `overage_status` rejected with an
  `overage_disabled_reason`.
* When it is **enabled on the account** and the user has said "never" here,
  this file is the only thing standing between a long turn and a bill. There is
  no flag that tells the CLI to refuse overage — it is an account-level setting
  — so the guard has to be ours, and it is built out of three parts:

  1. `is_using_overage` is a trip wire, not a data point. The tool sets it the
     moment paid usage starts covering the overflow, and that is the one signal
     that says money is being spent *now* rather than soon. It blocks the
     account on its own, whatever the windows say.
  2. A margin, sized by how coarsely the tool actually reports. Readings
     arrive in steps, and whatever the largest step seen on this account was,
     the next one can be that big again — so an account within one step of the
     threshold is already treated as over it. Until a step has been measured,
     `reserve` stands in for one. This is the part that turns "we found out
     afterwards" into "we stopped in time": the daemon is not guessing at token
     costs, it is bounding the only thing it cannot see, which is what happens
     between two reports.
  3. Nowhere left to move is a reason to stop, not to carry on. That decision
     lives in the server, but it is this file that says the account is spent.

The margin has a price: with "never", roughly one report-step of every window
goes unused. That is the honest cost of not overshooting, and it shrinks as
soon as a real step has been measured — the 10% default is only what is assumed
before anything is known.

Whose decision it is
--------------------
Per account, not per machine. A pool exists because the sign-ins differ, and
"extra usage is fine on my own account, never on the work one" is the ordinary
case rather than the exotic one. `use_overage` is the default for sign-ins that
have not been given an answer of their own; `overage_by_account` is where those
answers live.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict

# The window the plan's overage allowance is reported under; it is not one of
# the windows that can exhaust an account, it is the thing that rescues one.
OVERAGE = "overage"
# A limit reading older than this is treated as having no bearing on an idle
# account, even when its window has not formally reset: a week-old measurement
# of a five-hour window says nothing about now.
STALE_AFTER = 7 * 24 * 3600


def _util(v) -> float | None:
    """Utilization as a fraction. The SDK documents 0.0–1.0, but the CLI has
    reported percentages before; anything above 1.5 can only be one."""
    if not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f / 100 if f > 1.5 else f


def _ts(v) -> float | None:
    """A reset time in seconds. Milliseconds show up often enough to be worth
    catching — read as seconds they land in the year 33000 and no window ever
    looks like it has reset."""
    if not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f / 1000 if f > 1e11 else f


@dataclass
class Settings:
    """What the user decided the pool should do. Stored in config.toml."""
    enabled: bool = False
    # The share of a window at which an account is handed over, for any window
    # `thresholds` does not name. Deliberately short of 1.0: the point is to
    # move before the turn dies, not after.
    threshold: float = 0.99
    # Per window, because the windows are not alike. The five-hour one refills
    # several times a day, so stopping early costs little and overshooting it
    # is the common way to end up spending; the weekly ones are the whole
    # month's work and giving up 5% of one is expensive. Anything not named
    # here — a window this version has never heard of — falls back above.
    thresholds: dict[str, float] = field(default_factory=lambda: {"five_hour": 0.95})
    # The default answer for a sign-in that has not been given one of its own.
    # "account" — a sign-in with pay-as-you-go on stays in play past its plan.
    # "never"   — the plan's limit is the limit, whatever billing allows.
    use_overage: str = "account"
    # account id -> "account" | "never". One sign-in spending past its plan and
    # another never touching it is the ordinary case, not the exotic one.
    overage_by_account: dict[str, str] = field(default_factory=dict)
    # The step to assume before a real one has been measured. Readings arrive
    # in jumps, and the margin has to be at least as big as the next jump could
    # be; with no evidence yet, this is the guess. Once the account has been
    # watched for a while the measured worst step takes over whenever it is
    # larger. Ignored entirely where overage is allowed — there is nothing to
    # protect then, and holding plan back nobody is billed for throws it away.
    reserve: float = 0.10
    # provider -> account ids, in the order they are tried. An id that is not
    # here still plays; it just goes last. An id that no longer exists is
    # ignored rather than being an error — accounts get deleted.
    order: dict[str, list[str]] = field(default_factory=dict)
    # How many accounts one turn may be handed to before giving up. Without it
    # a machine whose accounts are all full would walk the whole list on every
    # message, opening and closing a CLI session for each.
    max_hops: int = 3

    @classmethod
    def from_dict(cls, raw: dict | None) -> "Settings":
        raw = raw or {}
        s = cls()
        if isinstance(raw.get("enabled"), bool):
            s.enabled = raw["enabled"]
        if isinstance(raw.get("threshold"), (int, float)):
            s.threshold = min(1.0, max(0.5, float(raw["threshold"])))
        per = raw.get("thresholds")
        if isinstance(per, dict):
            s.thresholds = {str(k): min(1.0, max(0.5, float(v)))
                            for k, v in per.items() if isinstance(v, (int, float))}
        if raw.get("use_overage") in ("account", "never"):
            s.use_overage = raw["use_overage"]
        by = raw.get("overage_by_account")
        if isinstance(by, dict):
            s.overage_by_account = {str(k): v for k, v in by.items()
                                    if v in ("account", "never")}
        if isinstance(raw.get("reserve"), (int, float)):
            s.reserve = min(0.5, max(0.0, float(raw["reserve"])))
        if isinstance(raw.get("max_hops"), int):
            s.max_hops = min(10, max(1, raw["max_hops"]))
        order = raw.get("order")
        if isinstance(order, dict):
            s.order = {str(k): [str(i) for i in v]
                       for k, v in order.items() if isinstance(v, list)}
        return s

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class State:
    """Where one account stands, as far as anything here can tell."""
    account_id: str
    blocked: bool = False
    # Which window did it, and when it comes back. None when nothing is wrong,
    # or when the block has no known end.
    window: str | None = None
    until: float | None = None
    # The fullest window that was measured, whether or not it blocks.
    utilization: float | None = None
    # True when the plan is spent but pay-as-you-go is carrying the account.
    on_overage: bool = False
    # The tool says paid extra usage is covering sends right now. Not the same
    # as on_overage, which is this file's own reading of the windows: this is
    # the tool's word for it, and it is what "never" trips on.
    spending: bool = False
    # The biggest jump ever seen between two consecutive readings of one
    # window on this account, and the margin actually applied (that step, or
    # `reserve` while nothing has been measured; zero where overage is fine).
    step: float | None = None
    margin: float = 0.0
    # This sign-in is not allowed to spend past its plan.
    strict: bool = False
    # Nothing has ever been measured for this account.
    unknown: bool = False

    def public(self) -> dict:
        return {"account_id": self.account_id, "blocked": self.blocked,
                "window": self.window, "until": self.until,
                "utilization": self.utilization, "on_overage": self.on_overage,
                "spending": self.spending, "step": self.step, "margin": self.margin,
                "strict": self.strict, "unknown": self.unknown}


class Pool:
    """The decision half. It owns no state of its own — accounts and limit
    readings are read live from the server, so there is one copy of each and
    no chance of the pool acting on a stale one."""

    def __init__(self, settings: Settings, accounts, limits):
        # accounts() -> {id: Account}, limits(key) -> [window row, …]
        self.settings = settings
        self._accounts = accounts
        self._limits = limits

    # ── keys ───────────────────────────────────────────────────────────────
    @staticmethod
    def key(account_id: str | None, provider: str) -> str:
        """The id limit readings are filed under. Matches what the server
        writes in `_remember_limits`: a chat with no account of its own is the
        machine's built-in sign-in for that tool."""
        return account_id or "default-" + provider

    # ── reading a plan ─────────────────────────────────────────────────────
    def overage_open(self, rows: list[dict], strict: bool) -> bool:
        """Is pay-as-you-go actually available on this account right now?

        Every row carries the account's overage fields — the server copies them
        onto each window precisely so any one of them can answer this. It is
        open when the tool says `allowed` and gives no reason why not, and when
        the user has not told us to ignore it.
        """
        if strict:
            return False
        for r in rows:
            status = r.get("overage_status")
            if status is None:
                continue
            return status in ("allowed", "allowed_warning") and not r.get("overage_disabled_reason")
        return False

    def threshold_for(self, window: str) -> float:
        """Where the line sits for one window, before any margin."""
        return self.settings.thresholds.get(window, self.settings.threshold)

    def policy(self, account_id: str) -> str:
        """This sign-in's own answer on extra usage, or the machine's default
        where it has not been given one."""
        return self.settings.overage_by_account.get(account_id) or self.settings.use_overage

    def must_not_spend(self, account_id: str) -> bool:
        """The user said this account's plan limit is the limit. Everything
        strict in here hangs off it, and nothing strict applies without it."""
        return self.policy(account_id) == "never"

    def state(self, account_id: str, provider: str, now: float | None = None) -> State:
        """Where an account stands.

        One question, asked the same way whether a turn is about to open here
        or is already running. It is tempting to be gentler on the running turn
        — cutting it throws work away, and not starting one costs nothing — but
        the thing being guarded against is the *next* reading, and a running
        turn is precisely what produces it. Asymmetry there would mean a turn
        allowed to continue into exactly the reading a turn was not allowed to
        start into.
        """
        now = now or time.time()
        rows = [r for r in self._limits(self.key(account_id, provider)) if isinstance(r, dict)]
        st = State(account_id=account_id)
        st.strict = self.must_not_spend(account_id)
        if not rows:
            st.unknown = True
            st.margin = self.settings.reserve if st.strict else 0.0
            return st

        rescue = self.overage_open(rows, st.strict)
        # How coarse this account's readings are. The next jump can be as big
        # as the biggest one seen, so anything within one of the threshold is
        # already over it as far as anyone here can prove otherwise.
        steps = [_util(r.get("step")) for r in rows]
        measured = [x for x in steps if x is not None]
        st.step = max(measured) if measured else None
        if st.strict:
            st.margin = max(st.step or 0.0, self.settings.reserve)

        # The tool's own word for "paid usage is covering sends right now".
        # Read together with the overage status, as the CLI's own note says to:
        # the flag stays set after the allowance is spent too, so alone it
        # cannot tell "still billing" from "billed until it ran out".
        if any(r.get("is_using_overage") for r in rows):
            status = next((r.get("overage_status") for r in rows
                           if r.get("overage_status") is not None), None)
            st.spending = status in ("allowed", "allowed_warning")
        worst: float | None = None
        blockers: list[tuple[str, float | None]] = []
        overage_spent = False

        for r in rows:
            window = str(r.get("window") or "")
            util = _util(r.get("utilization"))
            resets = _ts(r.get("resets_at"))
            at = r.get("at")
            # Each window has its own line, less the margin. The five-hour one
            # is held further back than the weeklies by default: it refills
            # several times a day, so stopping early there costs little, while
            # 5% of a weekly window is most of a working day.
            limit = max(0.5, self.threshold_for(window) - st.margin)
            full = r.get("status") == "rejected" or (util is not None and util >= limit)

            if window == OVERAGE:
                # The allowance itself running out is the one thing overage
                # cannot rescue an account from.
                if full and not (resets and resets <= now):
                    overage_spent = True
                continue

            if util is not None and (worst is None or util > worst):
                worst = util
            if not full:
                continue
            # Measured before the window it describes rolled over: whatever it
            # said then, the window is open again now.
            if resets and resets <= now:
                continue
            if isinstance(at, (int, float)) and now - at > STALE_AFTER:
                continue
            blockers.append((window, resets))

        st.utilization = worst
        st.on_overage = bool(blockers) and rescue and not overage_spent
        if st.spending and st.strict:
            # Money is going out of the door this second. Nothing about the
            # windows can make that acceptable, and waiting for one of them to
            # cross a threshold would be waiting while it is spent.
            st.blocked, st.window = True, OVERAGE
            st.until = next((_ts(r.get("overage_resets_at")) for r in rows
                             if r.get("overage_resets_at") is not None), None)
            return st
        if blockers and (not rescue or overage_spent):
            # Whichever blocking window comes back first is when the account
            # is worth trying again.
            window, until = min(blockers, key=lambda b: (b[1] is None, b[1] or 0))
            st.blocked, st.window, st.until = True, window, until
        return st

    # ── choosing ───────────────────────────────────────────────────────────
    def order(self, provider: str) -> list[str]:
        """Every account of this tool, in the order the pool tries them.

        The configured order first — that is the user's list, and the sign-in
        they want used by default is at the top of it. Anything not named comes
        after, in the order the accounts screen shows them, so a newly added
        sign-in joins the end of the queue instead of silently jumping it.
        """
        accounts = self._accounts()
        mine = [a for a in accounts.values() if a.provider == provider]
        mine.sort(key=lambda a: (a.home is not None, a.created_at))
        rest = [a.id for a in mine]
        out = [aid for aid in self.settings.order.get(provider, []) if aid in accounts
               and accounts[aid].provider == provider]
        out += [aid for aid in rest if aid not in out]
        return out

    def candidates(self, provider: str, exclude: set[str] | None = None,
                   now: float | None = None) -> list[str]:
        """The accounts a chat could be handed to, best first.

        Free accounts in the pool's own order, then the ones nothing is known
        about — an account that has never run is a guess either way, and a
        guess is worth less than a measurement that says there is room.

        """
        now = now or time.time()
        exclude = exclude or set()
        free: list[str] = []
        unknown: list[str] = []
        for aid in self.order(provider):
            if aid in exclude:
                continue
            st = self.state(aid, provider, now)
            if st.unknown:
                unknown.append(aid)
            elif not st.blocked:
                free.append(aid)
        return free + unknown

    def states(self, provider: str | None = None) -> list[dict]:
        """Everything the phone needs to draw the pool.

        In the order accounts are tried, not the order they were added: the
        list the phone shows is the policy, and a screen that lets it be
        reordered has to be reading the same sequence the pool acts on.
        """
        now = time.time()
        accounts = self._accounts()
        out = []
        for p in ([provider] if provider else sorted({a.provider for a in accounts.values()})):
            for aid in self.order(p):
                a = accounts[aid]
                out.append({"provider": a.provider, "label": a.label,
                            **self.state(a.id, a.provider, now).public()})
        return out
