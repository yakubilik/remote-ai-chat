#!/usr/bin/env python3
"""One client that stopped listening must not stop the house.

    python scripts/test_fanout.py

A socket can be dead and still look open: the phone went into a pocket, the
laptop slept, a NAT dropped an idle flow. A write into it does not fail, it
blocks — for minutes, until the OS gives up. The daemon used to broadcast by
awaiting each socket in turn, so one such client stopped every other device
receiving; and because a turn awaits the events it emits, the turn stopped too.
That is a long answer that "cuts off" halfway and only appears when something
else makes the client ask again.

Every client now has a queue and a writer of its own. Broadcasting is a put,
never a send, and a client that cannot keep up is closed rather than waited for.

No network: fake sockets, the real fan-out.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat.server import OUTBOX_MAX, Server

failures = 0


def ok(name: str, cond: bool, info: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(("OK  " if cond else "FAIL"), name, info)


class Sock:
    """A client socket. `stalled` never finishes a send, like a dead one."""

    def __init__(self, stalled: bool = False):
        self.stalled = stalled
        self.got: list[str] = []
        self.closed = False

    async def send_text(self, msg: str) -> None:
        if self.stalled:
            await asyncio.Event().wait()      # never returns, and never raises
        self.got.append(msg)

    async def close(self) -> None:
        self.closed = True


class Fanout:
    """Just enough of Server for the fan-out: the queues and their writers."""

    _enqueue = Server._enqueue
    send_to = Server.send_to
    _drop = Server._drop
    _writer = Server._writer
    broadcast = Server.broadcast

    def __init__(self):
        self.clients: dict = {}
        self.outbox: dict = {}
        self.writers: dict = {}

    def attach(self, ws: Sock) -> None:
        self.clients[ws] = object()
        self.outbox[ws] = asyncio.Queue()
        self.writers[ws] = asyncio.create_task(self._writer(ws, self.outbox[ws]))


async def main() -> int:
    f = Fanout()
    dead, live = Sock(stalled=True), Sock()
    f.attach(dead)
    f.attach(live)
    await asyncio.sleep(0)

    started = time.monotonic()
    for i in range(5):
        await f.broadcast({"event": "text.delta", "chat_id": "c", "seq": None,
                           "data": {"segment": 0, "text": f"tok{i}"}, "ts": time.time()})
    spent = time.monotonic() - started
    ok("broadcasting past a dead client does not wait", spent < 0.5, f"{spent:.3f}s")

    await asyncio.sleep(0.05)
    ok("the live client got everything", len(live.got) == 5, f"{len(live.got)}")
    ok("the dead client got nothing", live.got and not dead.got)

    # It is still queued for, up to a point.
    ok("the dead client is still connected", dead in f.outbox)
    for _ in range(OUTBOX_MAX + 5):
        await f.broadcast({"event": "text.delta", "chat_id": "c", "seq": None,
                           "data": {"text": "x"}, "ts": time.time()})
        await asyncio.sleep(0)     # a turn awaits its stream between events
    await asyncio.sleep(0.05)
    ok("a hopeless client is dropped, not grown", dead not in f.outbox)
    ok("dropping it closes its socket", dead.closed)
    ok("the live client is untouched", live in f.outbox and len(live.got) > OUTBOX_MAX)

    # A reply goes the same way an event does, so the two keep their order.
    await f.send_to(live, {"id": 1, "type": "ok", "data": {"hello": True}})
    await asyncio.sleep(0.05)
    ok("replies ride the same queue", '"hello"' in live.got[-1], live.got[-1][:40])

    for t in list(f.writers.values()):
        t.cancel()
    print(f"\n{'ok' if not failures else str(failures) + ' failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
