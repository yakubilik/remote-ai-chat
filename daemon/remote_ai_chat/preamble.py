"""What a session is told about itself, before it is told anything else.

A session started by this daemon has no way of knowing where it is. It sees a
working directory and a shell — the same two things it would see in a terminal —
and fills the rest in from whatever its instructions last mentioned. For months
that was a Telegram bridge which has nothing to do with this app, so sessions
introduced themselves as something they were not. A session wrong about how it
is being reached is wrong about who it is talking to, and answers the room it
imagines instead of the one it is in.

So the daemon says it outright, in the system prompt, on every session. The
facts here are the daemon's own — the host it runs on, the account it opened,
the directory it was pointed at — which is why they cannot go stale the way a
hand-written note in a settings file does. The note was what went stale.

The house style rides along for a different reason. It belongs to the person,
not to a computer, and this repository is the only thing every computer running
this daemon already agrees on. A style rule committed here is in force on the
Mac and on the Windows laptop by the next pull, and nothing was written into
anybody's own Claude settings to do it.

`house_style.md` is read fresh for each session, so editing it takes effect on
the next chat rather than the next restart.
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("rac.preamble")

STYLE_PATH = Path(__file__).with_name("house_style.md")

# Where a session goes when it actually needs the architecture, rather than the
# four facts above it. Kept out of the prompt itself: most turns never ask.
DEEP_DOC = "docs/session-context.md"


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    return None


def house_style() -> str:
    try:
        return STYLE_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:            # a missing style file must not cost a session
        log.warning("house style unreadable (%s); continuing without it", exc)
        return ""


def build(cfg, pc, tool: str = "claude") -> str:
    """The preamble for one session: where it is, then how to talk.

    `cfg` is the daemon's Config, `pc` the ProviderConfig for this chat.
    """
    root = _repo_root()
    doc = str(root / DEEP_DOC) if root else DEEP_DOC
    roots = ", ".join(cfg.allowed_roots) or "(none configured)"
    account = pc.account_id or "the computer's own login"
    model = pc.model + (f" ({pc.effort} effort)" if pc.effort else "")

    lines = [
        "<session-context>",
        f"You are running inside remote-ai-chat, a daemon on {cfg.host_name}.",
        "The person you are talking to is on their phone, in the remote-ai-chat app;",
        "their messages reach you over a WebSocket on the local network or tailnet.",
        "",
        "This is not a terminal session, and not any other bridge or bot your",
        "instructions may describe. Where they describe one, they are not describing",
        "this. Do not claim a channel you cannot see.",
        "",
        f"Tool: {tool} · Account: {account} · Model: {model}",
        f"Working directory: {pc.cwd}",
        f"Reachable roots: {roots}",
        "",
        "What follows from being on a phone:",
        "- Messages are short, and some are dictated and machine-transcribed. Odd word",
        "  choices, run-together words and missing punctuation are usually artifacts of",
        "  that, not the person's meaning. Read through them; ask only if it changes",
        "  what you would do.",
        "- The app renders your tool calls as they happen. Narrating them back is noise.",
        "- Long tables and deep-nested bullets do not survive the screen. Prose and a",
        "  short list do.",
        "- A permission request sends a push notification and may sit unanswered while",
        f"  the phone is in a pocket; it expires after {cfg.approval_timeout_s}s.",
        "  Ask for the approvals you need together rather than one at a time.",
        f"- An idle chat is closed after {cfg.idle_disconnect_s}s.",
        "- To show the person a file, name it in Markdown with its absolute path:",
        "  `![caption](/abs/path.png)` for a picture, `[name](/abs/path.pdf)` for",
        "  anything else. The app shows pictures inline and other files as an",
        "  attachment they can open or share. Only files under the reachable roots",
        "  are served; a path outside them stays plain text. This is the way to",
        "  send a screenshot, a rendered slide, a PDF — not e-mail, not base64.",
        "",
        "If you are asked how any of this works — ports, storage, accounts, updates,",
        f"security — read {doc}",
        "rather than guessing from this summary.",
        "</session-context>",
    ]
    style = house_style()
    if style:
        lines += ["", "<house-style>", style, "</house-style>"]
    return "\n".join(lines)
