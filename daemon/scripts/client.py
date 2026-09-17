"""Tiny terminal client for smoke-testing the daemon.

  python scripts/client.py --token TOKEN [--host 127.0.0.1] "prompt"
Auto-allows approvals when --auto-allow is set; otherwise asks on stdin.
"""
import argparse
import asyncio
import json
import sys
import time

import websockets


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("--token", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--provider", default="claude")
    ap.add_argument("--perm", default="ask")
    ap.add_argument("--chat", default=None, help="existing chat id (resume)")
    ap.add_argument("--auto-allow", action="store_true")
    a = ap.parse_args()

    uri = f"ws://{a.host}:{a.port}/ws?token={a.token}"
    async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
        rid = 0
        pending = {}

        async def call(typ, data):
            nonlocal rid
            rid += 1
            fut = asyncio.get_running_loop().create_future()
            pending[rid] = fut
            await ws.send(json.dumps({"id": rid, "type": typ, "data": data}))
            return await fut

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") in pending and m.get("type") in ("ok", "error"):
                    fut = pending.pop(m["id"])
                    (fut.set_result(m["data"]) if m["type"] == "ok"
                     else fut.set_exception(RuntimeError(m["data"]["message"])))
                    continue
                kind, d = m.get("event"), m.get("data") or {}
                if kind == "text.delta":
                    sys.stdout.write(d["text"]); sys.stdout.flush()
                elif kind == "tool.use":
                    print(f"\n⚙️  {d['tool']} {json.dumps(d['input'], ensure_ascii=False)[:200]}")
                elif kind == "tool.result":
                    print(f"   ↳ {'ERR ' if d['is_error'] else ''}{d['output'][:200]!r}")
                elif kind == "approval.request":
                    print(f"\n[approval] {d['preview']}  danger={d['danger']}")
                    if a.auto_allow:
                        decision = "allow"
                    else:                      # off-thread: input() would stall the loop
                        answer = await asyncio.to_thread(input, "allow/allow_session/deny> ")
                        decision = answer.strip() or "deny"
                    # Answer without waiting for the acknowledgement. This *is* the
                    # reader, so a `call()` here would wait for a reply only this
                    # loop can deliver, and the second approval would never arrive.
                    asyncio.create_task(call("approval.respond", {
                        "chat_id": m["chat_id"], "request_id": d["request_id"],
                        "decision": decision,
                    }))
                elif kind == "turn.done":
                    print(f"\n✅ done cost=${d.get('cost_usd')} {d.get('duration_ms')}ms turns={d.get('num_turns')}")
                    done.set()
                elif kind == "turn.error":
                    print(f"\n❌ {d['message']}"); done.set()
                elif kind in ("host.status",):
                    print(f"[host] {d.get('name')} claude={d.get('versions',{}).get('claude')}")

        done = asyncio.Event()
        rt = asyncio.create_task(reader())
        hello = await call("hello", {"device_name": "cli"})
        if a.chat:
            chat = (await call("chat.get", {"chat_id": a.chat}))["chat"]
        else:
            chat = await call("chat.create", {"provider": a.provider, "model": a.model,
                                              "perm_mode": a.perm, "cwd": a.cwd, "effort": "low"})
        print(f"[chat] {chat['id']} cwd={chat['cwd']} model={chat['model']} perm={chat['perm_mode']}")
        t0 = time.time()
        await call("chat.send", {"chat_id": chat["id"], "text": a.prompt})
        await done.wait()
        print(f"[{time.time()-t0:.1f}s] chat id: {chat['id']}")
        rt.cancel()


asyncio.run(main())
