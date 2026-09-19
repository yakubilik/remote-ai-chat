#!/usr/bin/env python3
"""A file the agent names is handed to the phone; a secret it names is not.

    python scripts/test_attachments.py

The agent's only way to show a file is to write its path into a message as a
Markdown image or link. What is guarded here: such a path inside an allowed
root becomes an attachment; a path outside the roots, a missing file, a URL, a
`.env` or anything under `.git` does not — and the text is never rewritten.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat import attachments as att        # noqa: E402
from remote_ai_chat.attachments import extract      # noqa: E402
from remote_ai_chat.security import PathPolicy       # noqa: E402


def main() -> int:
    fails = 0

    def check(name: str, ok: bool) -> None:
        nonlocal fails
        print(f"  {'ok  ' if ok else 'FAIL'}  {name}")
        fails += 0 if ok else 1

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "projects"
        proj = root / "demo"
        (proj / ".git").mkdir(parents=True)
        (proj / "out dir").mkdir()
        png = proj / "shot.png"; png.write_bytes(b"\x89PNG")
        pdf = proj / "out dir" / "deck.pdf"; pdf.write_bytes(b"%PDF")
        env = proj / ".env"; env.write_text("SECRET=1")
        head = proj / ".git" / "HEAD"; head.write_text("ref")
        outside = Path(tmp) / "elsewhere.txt"; outside.write_text("x")
        link = proj / "escape.txt"; link.symlink_to(outside)
        pol = PathPolicy([str(root)], [])

        text = (
            f"Screenshot: ![the page]({png})\n"
            f"Deck: [slides](<{pdf}>)\n"
            f"Also [again]({png}) and [via file](file://{png})\n"
            f"Not these: [env]({env}) [git]({head}) [out]({outside}) [link]({link})\n"
            f"[missing]({proj / 'nope.png'}) [web](https://example.com/a.png)\n"
        )
        got = extract(text, pol)
        paths = [a["path"] for a in got]

        check("image inside a root is lifted", str(png.resolve()) in paths)
        check("angle-bracketed path with a space is lifted", str(pdf.resolve()) in paths)
        check("each file once, however often it is named", paths.count(str(png.resolve())) == 1)
        check("order of mention is kept", paths[:2] == [str(png.resolve()), str(pdf.resolve())])
        check("kinds: png is image, pdf is file",
              [a["kind"] for a in got] == ["image", "file"])
        check("url is the /files route", all(a["url"] == f"/files?path={a['path']}" for a in got))
        check(".env is not lifted", str(env.resolve()) not in paths)
        check(".git/ is not lifted", str(head.resolve()) not in paths)
        check("outside the roots is not lifted", str(outside.resolve()) not in paths)
        check("a symlink out of the root is not lifted", len(got) == 2)
        check("policy: same rules answer /files", pol.is_servable(pdf) and not pol.is_servable(env)
              and not pol.is_servable(link) and not pol.is_servable(proj))
        check("plain prose yields nothing", extract("no files here, just /usr/bin talk", pol) == [])

        # The copy a bubble is drawn from. Pointed at the temp dir so the test
        # does not write into the real uploads folder.
        att.UPLOAD_DIR = Path(tmp) / "uploads"
        att.VIEW_DIR = att.UPLOAD_DIR / "shown"
        kept = att.keep_views(got)
        view = kept[0].get("view")
        check("a picture is given a view", bool(view) and Path(view).is_file())
        check("the view lives where /files will find it",
              view is not None and att.UPLOAD_DIR in Path(view).parents)
        check("path is left as the message wrote it", kept[0]["path"] == str(png.resolve()))
        check("a pdf is not copied", "view" not in kept[1])
        check("copying twice reuses the same file", att.keep_views(got)[0]["view"] == view)
        png.unlink()
        check("the view outlives the original", Path(view or "/nope").is_file())
        check("a view already under uploads is left alone",
              "view" not in att.keep_views([{"path": str(att.UPLOAD_DIR / "x.png"), "kind": "image"}])[0])

    print()
    print("all checks passed" if not fails else f"{fails} check(s) failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
