#!/usr/bin/env python3
"""A long chat must open at the end of itself, and a reconnect must catch up.

    python scripts/test_replay.py

`chat.get` answers in pages of 500. It used to answer every ask from the front,
which is right for a client catching up and wrong for one opening a chat: a
conversation with two and a half thousand events handed back its first
afternoon and nothing since. The phone showed a chat that had stopped days ago
while the panel — which had been fed live the whole time and never truncated —
showed the real one. That is what "the phone is not in sync" was.

So: `since_seq: 0` is answered from the tail, and says `truncated` when there is
history above it. A `since_seq` is answered forward and says `more` while events
remain, so a client that was away can walk to the end instead of stopping one
page short and appending everything afterwards onto a hole.

No network, no turns: the database and the handler, directly.
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat.db import DB

TOTAL = 1200
PAGE = 500
failures = 0


def ok(name: str, cond: bool, info: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(("OK  " if cond else "FAIL"), name, info)


class FakeServer:
    """Just enough of Server for h_chat_get: it touches db and sessions only."""

    def __init__(self, db: DB):
        self.db = db
        self.sessions = self

    def peek(self, _cid):            # no live session in this test
        return None


async def main() -> int:
    from remote_ai_chat.server import Server

    with tempfile.TemporaryDirectory() as tmp:
        db = DB(Path(tmp) / "t.sqlite")
        chat = db.create_chat(provider="claude", cwd=tmp, model="m")
        cid = chat["id"]
        for i in range(TOTAL):
            db.append_event(cid, "message.user", {"text": f"m{i}"})
        last_seq = db.last_seq(cid)

        srv = FakeServer(db)
        get = Server.h_chat_get.__get__(srv, FakeServer)

        # A cold open lands on the end of the conversation, not the start of it.
        r = await get(None, {"chat_id": cid})
        ok("cold open returns one page", len(r["events"]) == PAGE, f"{len(r['events'])}")
        ok("cold open is the tail", r["events"][-1]["seq"] == last_seq,
           f"last={r['events'][-1]['seq']} of {last_seq}")
        ok("cold open says history was cut", r["truncated"] is True)
        ok("cold open has nothing more to page", r["more"] is False)

        # A client that was away walks forward until the daemon stops saying
        # more. It always has a seq to walk from — a client with none is a cold
        # open, which is the tail, above.
        first_seq = last_seq - TOTAL + 1
        since, seen, pages = first_seq, 0, 0
        while pages < 10:
            r = await get(None, {"chat_id": cid, "since_seq": since})
            pages += 1
            evs = r["events"]
            seen += len(evs)
            ok(f"page {pages} is in order", all(
                evs[i]["seq"] < evs[i + 1]["seq"] for i in range(len(evs) - 1)))
            if not r["more"]:
                break
            since = evs[-1]["seq"]
        ok("catching up needs three pages", pages == 3, f"{pages}")
        ok("catching up sees everything it missed", seen == TOTAL - 1, f"{seen} of {TOTAL - 1}")

        # The last page is the one that says there is nothing after it.
        r = await get(None, {"chat_id": cid, "since_seq": last_seq})
        ok("caught up returns nothing", r["events"] == [] and r["more"] is False)

        # A short chat is not truncated, whichever end it is asked from.
        short = db.create_chat(provider="claude", cwd=tmp, model="m")["id"]
        for i in range(3):
            db.append_event(short, "message.user", {"text": str(i)})
        r = await get(None, {"chat_id": short})
        ok("a short chat comes back whole", len(r["events"]) == 3 and r["truncated"] is False)

    print(f"\n{'ok' if not failures else str(failures) + ' failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
