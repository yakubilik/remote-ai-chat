"""Protocol smoke test that spends no Claude/Codex turns: hello, host.info, groups,
cwd policy, upload + /files, archive, delete. Safe to run on any machine right
after install.ps1 / install.sh; the model-side checks live in e2e.py.

  python scripts/smoke.py --token TOKEN [--host 127.0.0.1] [--cwd ~/projects]
"""
import argparse, asyncio, json, os, pathlib, sys
import httpx, websockets

ap = argparse.ArgumentParser()
ap.add_argument("--token", required=True)
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--cwd", default=os.path.expanduser("~/projects"), help="a folder inside the daemon's allowed roots")
ap.add_argument("--audio", default=None, help="a short m4a/mp3 voice note; checks that /upload returns a transcript")
a = ap.parse_args()
HOME = pathlib.Path.home()
# The daemon under test may be a second one on this machine; RAC_HOME is what
# moves its config, database and uploads somewhere else.
RAC_HOME = pathlib.Path(os.environ.get("RAC_HOME") or (HOME / ".remote-ai-chat")).expanduser()
WIN = sys.platform == "win32"
results = []


def ok(name, cond, info=""):
    results.append((name, bool(cond)))
    print(("OK  " if cond else "FAIL"), name, info)


async def main():
    async with websockets.connect(f"ws://{a.host}:{a.port}/ws?token={a.token}", max_size=16 * 1024 * 1024) as ws:
        rid = 0
        pending = {}

        async def call(t, d=None):
            nonlocal rid
            rid += 1
            fut = asyncio.get_running_loop().create_future()
            pending[rid] = fut
            await ws.send(json.dumps({"id": rid, "type": t, "data": d or {}}))
            return await asyncio.wait_for(fut, 30)

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") in pending and m.get("type") in ("ok", "error"):
                    f = pending.pop(m["id"])
                    if m["type"] == "ok":
                        f.set_result(m["data"])
                    else:
                        f.set_exception(RuntimeError(m["data"]["message"]))

        asyncio.create_task(reader())
        hello = await call("hello", {"device_name": "smoke", "lang": "en"})
        ok("hello returns catalog+device", "catalog" in hello and "device" in hello)

        hi = await call("host.info")
        ok("host.info has os/version", hi.get("os") and hi.get("os_version"), f'{hi.get("os")} {hi.get("os_version")}')
        if WIN:
            ok("os_version is the real build on Windows", str(hi.get("os_version", "")).startswith("10.0."), hi.get("os_version"))
            try:
                import faster_whisper  # noqa: F401
                ok("transcription available (faster-whisper)", hi.get("transcription") is True)
            except ImportError:
                ok("transcription reported unavailable", hi.get("transcription") is False)
        cv = (hi.get("versions") or {}).get("claude") or ""
        ok("claude version resolved (PATH or bundled CLI)", any(ch.isdigit() for ch in cv), str(hi.get("versions")))

        pr = await call("host.projects")
        ok("host.projects returns roots", bool(pr.get("roots")), f'{len(pr.get("projects", []))} projects under {pr.get("roots")}')

        for old in (await call("group.list"))["groups"]:
            if old["name"].startswith("Smoke"):
                await call("group.delete", {"group_id": old["id"]})
        g = await call("group.create", {"name": "Smoke"})
        cwd = str(pathlib.Path(a.cwd).expanduser().resolve())
        chat = await call("chat.create", {"provider": "claude", "model": "haiku", "effort": "low", "perm_mode": "ask",
                                          "cwd": cwd, "group_id": g["id"]})
        cid = chat["id"]
        ok("chat.create with cwd", chat["cwd"].lower() == cwd.lower(), chat["cwd"])

        # chat.update must store the same canonical form as chat.create
        alt = cwd.replace("\\", "/")
        if WIN:
            alt = alt.upper()
        upd = await call("chat.update", {"chat_id": cid, "cwd": alt})
        ok("chat.update normalizes cwd", upd["cwd"] == chat["cwd"], upd["cwd"])

        for label, bad_cwd in (("denied path", str(HOME / ("AppData" if WIN else ".ssh"))),
                               ("outside roots", "C:\\Windows" if WIN else "/etc")):
            err = None
            try:
                await call("chat.update", {"chat_id": cid, "cwd": bad_cwd})
            except Exception as e:
                err = str(e)
            ok(f"cwd {label} rejected", err is not None, err or "")

        async with httpx.AsyncClient(base_url=f"http://{a.host}:{a.port}", timeout=30) as hc:
            auth = {"Authorization": f"Bearer {a.token}"}
            r = await hc.post("/upload", files={"file": ("note.txt", b"hello", "text/plain")}, data={"chat_id": cid}, headers=auth)
            ok("POST /upload", r.status_code == 200, r.text[:100])
            path = r.json().get("path", "")
            uploads = RAC_HOME / "uploads"
            ok("upload lands under the daemon's uploads folder", path.lower().startswith(str(uploads).lower()) and os.path.isfile(path), path)
            r2 = await hc.get("/files", params={"path": path, "token": a.token})
            ok("GET /files round-trips", r2.status_code == 200 and r2.content == b"hello", str(r2.status_code))
            r3 = await hc.get("/files", params={"path": str(RAC_HOME / "config.toml"), "token": a.token})
            ok("GET /files refuses paths outside uploads", r3.status_code == 404, str(r3.status_code))
            r4 = await hc.get("/files", params={"path": path, "token": "wrong"})
            ok("GET /files refuses a bad token", r4.status_code == 401, str(r4.status_code))
            if a.audio and not os.path.isfile(a.audio):
                print("FAIL --audio: no such file:", a.audio)
                results.append(("audio file exists", False))
            if a.audio and os.path.isfile(a.audio):
                name = os.path.basename(a.audio)
                with open(a.audio, "rb") as fh:
                    r5 = await hc.post("/upload", files={"file": (name, fh, "audio/mp4")}, data={"chat_id": cid},
                                       headers=auth, timeout=900)
                tr = (r5.json().get("transcript") or "") if r5.status_code == 200 else ""
                ok("audio upload returns a transcript", r5.status_code == 200 and len(tr) > 3, tr[:80] or r5.text[:80])

        await call("chat.update", {"chat_id": cid, "archived": 1})
        l1 = await call("chat.list")
        l2 = await call("chat.list", {"include_archived": True})
        ok("archived hidden unless requested", all(c["id"] != cid for c in l1["chats"]) and any(c["id"] == cid for c in l2["chats"]))
        await call("chat.delete", {"chat_id": cid})
        ok("chat.delete removes the upload folder", not os.path.exists(os.path.dirname(path)), os.path.dirname(path))
        await call("group.delete", {"group_id": g["id"]})
        ok("group.delete", all(x["id"] != g["id"] for x in (await call("group.list"))["groups"]))

    print("\n%d/%d passed" % (sum(1 for r in results if r[1]), len(results)))
    sys.exit(0 if all(r[1] for r in results) else 1)


asyncio.run(main())
