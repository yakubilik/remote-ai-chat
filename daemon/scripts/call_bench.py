"""Measure the concierge: how fast, and is the answer any good.

  python scripts/call_bench.py --token TOKEN
  python scripts/call_bench.py --token TOKEN --digest
  python scripts/call_bench.py --token TOKEN -q "focus'ta ne oluyor" -q "bitti mi"

Phase 1 of the voice call has no voice in it on purpose. The risk in a phone
call is latency, not audio, and latency is measurable over plain text — if the
numbers here are bad, no amount of speech synthesis will save the feature.

Read the printed answers as well as the milliseconds. An answer that is fast,
correct, and unspeakable (paths, code, four sentences) is still a failure.
"""
import argparse
import asyncio
import json
import statistics
import sys
import time

import websockets

# The questions a person actually asks a computer from a bus stop.
DEFAULT = [
    "What is running right now?",
    "Is anything waiting on me?",
    "What did it do last?",
    "How much have I spent?",
    "Is anything stuck?",
    # One in the other language: the concierge is bilingual and the answer has
    # to come back in the language it was asked in.
    "Onay bekleyen bir şey var mı?",
]


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("-q", "--question", action="append", default=[],
                    help="ask this instead of the built-in set (repeatable)")
    ap.add_argument("--digest", action="store_true", help="print the snapshot and stop")
    ap.add_argument("--rounds", type=int, default=1, help="repeat the question set")
    a = ap.parse_args()

    questions = (a.question or DEFAULT) * a.rounds
    uri = f"ws://{a.host}:{a.port}/ws?token={a.token}"

    async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
        rid = 0
        pending: dict[int, asyncio.Future] = {}

        async def call(typ: str, data: dict):
            nonlocal rid
            rid += 1
            fut = asyncio.get_running_loop().create_future()
            pending[rid] = fut
            await ws.send(json.dumps({"id": rid, "type": typ, "data": data}))
            return await fut

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                fut = pending.pop(m.get("id"), None) if m.get("type") in ("ok", "error") else None
                if fut is None:
                    continue
                (fut.set_result(m["data"]) if m["type"] == "ok"
                 else fut.set_exception(RuntimeError(m["data"]["message"])))

        rt = asyncio.create_task(reader())
        try:
            snap = (await call("call.digest", {}))["digest"]
            if a.digest:
                print(snap)
                return 0
            print(f"— snapshot: {len(snap)} chars, "
                  f"{len(snap.splitlines())} lines —\n")

            # The first question pays for starting the CLI. Reporting it in the
            # same pot as the rest would hide the number that matters: what a
            # follow-up costs once the call is already up.
            print("warming up the session…")
            warm = await call("call.ask", {"text": "Kaç sohbet var?", "reset": True})
            print(f"  cold start: {warm['ms']}ms "
                  f"(connect {warm['connect_ms']}ms)\n  {warm['text']}\n")

            times: list[int] = []
            firsts: list[int] = []
            costs = 0.0
            for q in questions:
                t0 = time.monotonic()
                r = await call("call.ask", {"text": q})
                rtt = int((time.monotonic() - t0) * 1000)
                times.append(rtt)
                if r.get("first_token_ms"):
                    firsts.append(r["first_token_ms"])
                costs += r.get("cost_usd") or 0.0
                words = len(r["text"].split())
                print(f"[{rtt:>5}ms  first {r.get('first_token_ms') or '?'}ms  {words:>2}w]  {q}")
                print(f"         → {r['text']}\n")

            times.sort()
            p = lambda xs, q: xs[min(len(xs) - 1, int(len(xs) * q))]
            print("— warm answers —")
            print(f"  median   {statistics.median(times):.0f}ms")
            print(f"  p95      {p(times, 0.95)}ms")
            print(f"  worst    {times[-1]}ms")
            if firsts:
                firsts.sort()
                print(f"  first token, median {statistics.median(firsts):.0f}ms")
            print(f"  spent    ${costs:.4f} over {len(times)} questions")
            print("\nA call feels live under about 1500ms to the first spoken word.")
        finally:
            rt.cancel()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
