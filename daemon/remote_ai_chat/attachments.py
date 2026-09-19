"""Files the agent shows the person.

The phone can hand the agent a file — there is an upload button. The agent had
no way back: a screenshot it took or a PDF it built could only be described,
and a described picture is not a picture. What the agent does have is text, so
a file it wants seen is named the way Markdown already names one —
`![caption](/abs/path.png)` for a picture, `[name](/abs/path.pdf)` for anything
else — and the daemon lifts those out of each assistant message into an
`attachments` list before the phone sees it. The text is left as written: it is
the record, and a client that knows nothing of attachments still shows a path
a person can read.

Only a file the path policy would serve is lifted (inside an allowed root,
not a secret), plus anything under the uploads folder, which the phone sent
in the first place. A path that fails the policy is simply not an attachment;
the text still says it, and `/files` would refuse it anyway.

A picture also gets a copy of itself kept here (`view`), because a screenshot
belongs to the transcript and the file it was read from does not: the agent
tidies up after itself, the branch changes, the folder goes — and a bubble
whose picture is a 404 shows a file name where a picture was. The copy lives
under the uploads folder, which `/files` serves regardless of where the
original stood, so a chat scrolled back to next week still has its pictures.
"""
from __future__ import annotations

import hashlib
import logging
import re
import shutil
import subprocess
from pathlib import Path

from .config import UPLOAD_DIR
from .security import PathPolicy

log = logging.getLogger("rac.attachments")

# Only the media extensions need naming: an image is normalized, a video gets a
# player, audio is transcribed. Everything else is just "file".
KINDS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image",
    ".mp4": "video", ".mov": "video", ".m4v": "video",
    ".m4a": "audio", ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".caf": "audio", ".aac": "audio",
}

# `![alt](target)` or `[label](target)` where target is a local path: absolute
# (`/…`, `~/…`, `C:\…`), optionally `file://`, optionally wrapped in `<…>`
# (the Markdown spelling for a path with spaces). URLs are not matched.
_REF = re.compile(
    r"!?\[[^\]\n]*\]\(\s*(?:<(?P<angled>[^>\n]+)>|(?P<bare>(?:file://)?(?:~|/|[A-Za-z]:[\\/])[^)\s]*))\s*\)"
)

MAX_PER_MESSAGE = 12


def kind_of(path: str | Path) -> str:
    return KINDS.get(Path(path).suffix.lower(), "file")


def _candidates(text: str) -> list[str]:
    out: list[str] = []
    for m in _REF.finditer(text):
        raw = (m.group("angled") or m.group("bare") or "").strip()
        if raw.startswith("file://"):
            raw = raw[7:]
        if raw and raw not in out:
            out.append(raw)
    return out


def extract(text: str, policy: PathPolicy) -> list[dict]:
    """The attachments named in one assistant message, in order of mention."""
    if not text or "](" not in text:
        return []
    out: list[dict] = []
    uploads = UPLOAD_DIR.resolve()
    for raw in _candidates(text):
        try:
            p = Path(raw).expanduser().resolve(strict=True)
        except Exception:
            continue
        if not p.is_file():
            continue
        if not (uploads in p.parents or policy.is_servable(p)):
            continue
        out.append({"path": str(p), "name": p.name, "size": p.stat().st_size,
                    "kind": kind_of(p), "url": f"/files?path={p}"})
        if len(out) >= MAX_PER_MESSAGE:
            break
    return out


# ── the copy a bubble is drawn from ──────────────────────────────────────────

VIEW_DIR = UPLOAD_DIR / "shown"


def keep_views(atts: list[dict]) -> list[dict]:
    """Give every picture a `view`: a copy under the uploads folder for the
    bubble to draw. `path` is left alone — it is what the message says, what
    the download link opens, and what the clients match the text against."""
    out = []
    for a in atts:
        if a.get("kind") != "image" or a.get("view"):
            out.append(a)
            continue
        view = _keep(Path(a["path"]))
        out.append({**a, "view": str(view)} if view else a)
    return out


# Past this a picture is re-encoded on the way into the copy; under it the file
# is copied as it is. A screenshot of an interface is mostly text, and text is
# the one thing JPEG is bad at — it is not worth blurring a 200 KB PNG.
KEEP_AS_IS = 800 * 1024


def _keep(src: Path) -> Path | None:
    """The kept copy of one picture, made once. None if it cannot be made —
    a bubble then draws from the original, which is what it did before."""
    try:
        if UPLOAD_DIR.resolve() in src.resolve().parents:
            return None                      # already somewhere /files will find it
        digest = hashlib.sha1(str(src.resolve()).encode()).hexdigest()[:10]
        stem = "".join(c for c in src.stem if c.isalnum() or c in "-_")[:40] or "image"
        VIEW_DIR.mkdir(parents=True, exist_ok=True)
        plain = VIEW_DIR / f"{stem}-{digest}{src.suffix.lower()}"
        shrunk = VIEW_DIR / f"{stem}-{digest}.jpg"
        for out in (plain, shrunk):
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                return out
        if src.stat().st_size <= KEEP_AS_IS:
            shutil.copy2(src, plain)
            return plain
        if _shrink(src, shrunk):
            return shrunk
        shutil.copy2(src, plain)
        return plain
    except Exception as exc:
        log.warning("keeping a copy of %s failed: %s", src.name, exc)
        return None


def normalize_image(path: Path) -> Path:
    """HEIC or oversized photos → JPEG ≤ 1600 px so Claude Code's Read (256 KB cap for
    text, image previews OK up to a few MB) can actually look at them.

    macOS has `sips` built in; elsewhere Pillow does the same job. Without either
    the file is passed through untouched and the model may not be able to read it."""
    try:
        heic = path.suffix.lower() in (".heic", ".heif")
        big = path.stat().st_size > 600 * 1024
        if not (heic or big):
            return path
        out = path.with_suffix(".jpg") if heic else path.with_name(path.stem + "-web.jpg")
        if _shrink(path, out):
            if out != path:
                path.unlink(missing_ok=True)
            return out
        log.warning("no image converter available (install Pillow) — sending %s as is", path.name)
    except Exception as exc:
        log.warning("image normalize failed: %s", exc)
    return path


def _shrink(src: Path, dst: Path) -> bool:
    """One picture, re-encoded as a JPEG no wider than 1600 px. macOS has `sips`;
    everywhere else Pillow does it."""
    if shutil.which("sips"):
        try:
            r = subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "1600",
                                str(src), "--out", str(dst)], capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and dst.exists():
                return True
            log.warning("sips failed: %s", r.stderr.strip()[:200])
        except Exception as exc:
            log.warning("sips failed: %s", exc)
    return _pillow_resize(src, dst)


def _pillow_resize(src: Path, dst: Path) -> bool:
    """Pillow path, used on Windows and Linux. HEIC needs pillow-heif."""
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        try:
            import pillow_heif                      # noqa: F401
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((1600, 1600))
            im.save(dst, "JPEG", quality=82, optimize=True)
        return dst.exists()
    except Exception as exc:
        log.warning("pillow convert failed: %s", exc)
        return False
