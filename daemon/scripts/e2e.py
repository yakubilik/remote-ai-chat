"""End-to-end checks against a running daemon. Costs a few Claude turns.
  python scripts/e2e.py --token TOKEN
"""
import argparse, asyncio, json, sys, time, os
import websockets

ap = argparse.ArgumentParser(); ap.add_argument("--token", required=True); ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--image", default=None)
ap.add_argument("--cwd", default=os.path.expanduser("~/projects/remote-ai-chat"), help="an allowed project folder on the daemon's machine")
a = ap.parse_args()
CWD = a.cwd
results = []
def ok(name, cond, info=""):
    results.append((name, bool(cond), info)); print(("✅" if cond else "❌"), name, info)

async def main():
    async with websockets.connect(f"ws://{a.host}:{a.port}/ws?token={a.token}", max_size=16*1024*1024) as ws:
        rid = 0; pending = {}; events = []; waiters = []
        async def call(t, d=None):
            nonlocal rid; rid += 1; fut = asyncio.get_running_loop().create_future(); pending[rid] = fut
            await ws.send(json.dumps({"id": rid, "type": t, "data": d or {}})); return await asyncio.wait_for(fut, 60)
        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") in pending and m.get("type") in ("ok", "error"):
                    f = pending.pop(m["id"]); (f.set_result(m["data"]) if m["type"] == "ok" else f.set_exception(RuntimeError(m["data"]["message"]))); continue
                if m.get("type") == "event":
                    events.append(m)
                    for w in list(waiters):
                        if w[0](m) and not w[1].done(): w[1].set_result(m)
        async def wait_for(pred, timeout=240):
            fut = asyncio.get_running_loop().create_future(); waiters.append((pred, fut))
            try: return await asyncio.wait_for(fut, timeout)
            finally: waiters.remove((pred, fut))
        asyncio.create_task(reader())
        async def auto_approver():
            # allow every non-dangerous approval (the deny test targets a dangerous one)
            seen = set()
            while True:
                for m in list(events):
                    if m["event"] == "approval.request" and not m["data"]["danger"] and m["data"]["request_id"] not in seen:
                        seen.add(m["data"]["request_id"])
                        try: await call("approval.respond", {"chat_id": m["chat_id"], "request_id": m["data"]["request_id"], "decision": "allow"})
                        except Exception: pass
                await asyncio.sleep(0.3)
        asyncio.create_task(auto_approver())
        hello = await call("hello", {"device_name": "e2e", "lang": "en"})
        ok("hello returns catalog+device", "catalog" in hello and "device" in hello)

        # ── groups (clean leftovers from interrupted runs first)
        for old in (await call("group.list"))["groups"]:
            if old["name"].startswith("E2E"):
                await call("group.delete", {"group_id": old["id"]})
        g = await call("group.create", {"name": "E2E Group"})
        await call("group.rename", {"group_id": g["id"], "name": "E2E Renamed"})
        gl = await call("group.list")
        ok("group create+rename", any(x["id"] == g["id"] and x["name"] == "E2E Renamed" for x in gl["groups"]))

        # ── chat create + update fields
        chat = await call("chat.create", {"provider": "claude", "model": "sonnet", "effort": "low", "perm_mode": "ask", "cwd": CWD, "group_id": g["id"]})
        cid = chat["id"]
        upd = await call("chat.update", {"chat_id": cid, "title": "E2E chat", "pinned": 1, "max_turns": 6})
        ok("chat.update title/pinned/max_turns", upd["title"] == "E2E chat" and upd["pinned"] == 1 and upd["max_turns"] == 6)
        bad = None
        try: await call("chat.update", {"chat_id": cid, "cwd": os.path.expanduser("~/.ssh")})
        except Exception as e: bad = str(e)
        ok("cwd outside roots rejected", bad is not None, bad or "")

        # ── turn 1: remember a word (tests basic + later resume)
        await call("chat.send", {"chat_id": cid, "text": "Remember the code word ZEBRA-42. Reply with just: ok"})
        done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"))
        ok("turn 1 completes", done["event"] == "turn.done", done["data"].get("message", ""))
        # ── turn 2: resume (same chat, provider kept)
        await call("chat.send", {"chat_id": cid, "text": "What was the code word? Reply with just the code word."})
        done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"))
        texts = [m["data"]["text"] for m in events if m["chat_id"] == cid and m["event"] == "message.assistant"]
        ok("turn 2 resume remembers context", done["event"] == "turn.done" and any("ZEBRA-42" in t for t in texts[-2:]), (texts[-1] if texts else "")[:60])
        # ── reconfigure while idle then resume again (session kept across provider rebuild)
        await call("chat.update", {"chat_id": cid, "model": "haiku", "effort": None})
        await call("chat.send", {"chat_id": cid, "text": "Again, just the code word."})
        done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"))
        texts = [m["data"]["text"] for m in events if m["chat_id"] == cid and m["event"] == "message.assistant"]
        ok("resume after model change keeps session", done["event"] == "turn.done" and "ZEBRA-42" in (texts[-1] if texts else ""), (texts[-1] if texts else done["data"].get("message",""))[:60])

        # ── deny path on a dangerous command
        await call("chat.send", {"chat_id": cid, "text": "Run the shell command `echo reboot` and tell me its output in one short sentence. If you are not allowed, say 'denied' and stop."})
        req = await wait_for(lambda m: m["chat_id"] == cid and m["event"] == "approval.request", 120)
        ok("dangerous command asks approval", req["data"]["danger"] is True, req["data"]["preview"])
        st = await call("chat.get", {"chat_id": cid})
        ok("status awaiting_approval + pending listed", st["chat"]["status"] == "awaiting_approval" and req["data"]["request_id"] in st["pending_approvals"])
        await call("approval.respond", {"chat_id": cid, "request_id": req["data"]["request_id"], "decision": "deny"})
        res = await wait_for(lambda m: m["chat_id"] == cid and m["event"] == "approval.resolved")
        done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"))
        ok("deny resolves and turn ends", res["data"]["decision"] == "deny" and done["event"] == "turn.done", done["data"].get("message",""))
        dup = None
        try: await call("approval.respond", {"chat_id": cid, "request_id": req["data"]["request_id"], "decision": "allow"})
        except Exception as e: dup = str(e)
        ok("stale approval rejected", dup is not None)

        # ── queue while busy + interrupt
        await call("chat.send", {"chat_id": cid, "text": "Count from 1 to 400 slowly, one number per line, no tools."})
        await wait_for(lambda m: m["chat_id"] == cid and m["event"] == "text.delta", 120)
        res = await call("chat.send", {"chat_id": cid, "text": "hi"})
        ok("send while busy is queued, not rejected", res.get("queued") is True, str(res))
        # Interrupt drops the queue, so the queued "hi" must not start a turn of
        # its own after the stop — the next turn.done belongs to the count.
        await call("chat.interrupt", {"chat_id": cid})
        done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"), 60)
        st = await call("chat.get", {"chat_id": cid})
        ok("interrupt ends turn as done/interrupted, status idle", st["chat"]["status"] == "idle" and not st["busy"] and done["event"] == "turn.done" and done["data"].get("stop_reason") == "interrupted", f'{done["event"]} {done["data"].get("stop_reason") or done["data"].get("message","")}')

        # ── attachment
        if a.image and os.path.exists(a.image):
            await call("chat.send", {"chat_id": cid, "text": "Look at the attached image and describe it in one short sentence.", "attachments": [{"path": a.image, "name": os.path.basename(a.image)}]})
            done = await wait_for(lambda m: m["chat_id"] == cid and m["event"] in ("turn.done", "turn.error"))
            texts = [m["data"]["text"] for m in events if m["chat_id"] == cid and m["event"] == "message.assistant"]
            ok("attachment described", done["event"] == "turn.done" and bool(texts) and len(texts[-1]) > 10, (texts[-1] if texts else "")[:80])

        # ── chat.get since_seq
        st = await call("chat.get", {"chat_id": cid})
        last = st["events"][-1]["seq"]
        st2 = await call("chat.get", {"chat_id": cid, "since_seq": last})
        ok("since_seq returns nothing new", st2["events"] == [])

        # ── archive / list filtering / delete / group delete
        await call("chat.update", {"chat_id": cid, "archived": 1})
        l1 = await call("chat.list"); l2 = await call("chat.list", {"include_archived": True})
        ok("archived hidden unless requested", all(c["id"] != cid for c in l1["chats"]) and any(c["id"] == cid for c in l2["chats"]))
        await call("group.delete", {"group_id": g["id"]})
        c = (await call("chat.get", {"chat_id": cid}))["chat"]
        ok("group delete ungroups chat", c["group_id"] is None)
        await call("chat.delete", {"chat_id": cid})
        gone = None
        try: await call("chat.get", {"chat_id": cid})
        except Exception as e: gone = str(e)
        ok("chat deleted", gone is not None)

    print("\n%d/%d passed" % (sum(1 for r in results if r[1]), len(results)))
    sys.exit(0 if all(r[1] for r in results) else 1)

asyncio.run(main())
