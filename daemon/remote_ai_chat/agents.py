"""Agents defined on the computer, listed for the phone.

Each agent is a markdown file with a small YAML-ish header. Only the header is
read: the body is the agent's own prompt and is none of the app's business.
"""
from __future__ import annotations

import re
from pathlib import Path

from .accounts import ACCOUNTS_DIR, DEFAULT_ID
from .config import CONFIG_DIR
from .errors import Err

# Where the CLI keeps them, in the order the CLI itself prefers: a project's own
# agents win over the ones shared across every project.
def _dirs(account_home: str | None, cwd: str | None) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    if cwd:
        out.append((Path(cwd) / ".claude" / "agents", "project"))
    out.append((Path(account_home) / "agents" if account_home else DEFAULT_AGENTS, "user"))
    out.append((Path.home() / ".claude" / "agents", "user"))
    return out


# The built-in account has no home of its own, so what the app installs for it
# lives here rather than in the machine's folder.
DEFAULT_AGENTS = ACCOUNTS_DIR / DEFAULT_ID / "agents"


def _app_installed(path: Path) -> bool:
    """Whether this app put the agent there.

    The machine's own agents folder holds real files too, and for the built-in
    account it used to be the folder listed — so "not a symlink" alone called
    every worker of every tool on the computer one of ours. Only a real file in
    an account folder of this app's own counts.
    """
    if path.is_symlink():
        return False
    try:
        return path.parent.parent.parent.resolve() == ACCOUNTS_DIR.resolve()
    except OSError:
        return False


HEADER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)
FIELD = re.compile(r"^([A-Za-z_]+)\s*:\s*(.*)$")

# A stable colour and glyph per agent, so a list of them is scannable without
# anyone having to draw an icon for each.
GLYPHS = ["🧪", "📐", "🗺️", "🐞", "🧭", "📊", "🧱", "🔍", "🧰", "✒️", "🛰️", "🧠"]
COLORS = ["#C2522D", "#4C8DD9", "#6FA96F", "#D8A657", "#9A6BD8", "#3FA9A0"]


def _header(text: str) -> dict[str, str]:
    m = HEADER.match(text)
    if not m:
        return {}
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        fm = FIELD.match(line.strip())
        if fm:
            out[fm.group(1).lower()] = fm.group(2).strip().strip('"').strip("'")
    return out


HEX = re.compile(r"^#[0-9A-Fa-f]{3,8}$")


def _hex(v: str | None) -> str | None:
    """Only a real colour survives: the CLI also accepts names like "cyan",
    which mean nothing to the phone's palette."""
    v = (v or "").strip()
    return v if HEX.match(v) else None


def body(path: str) -> str:
    """The agent's own prompt, without its header."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")[:60000]
    except OSError:
        return ""
    m = HEADER.match(text)
    return (text[m.end():] if m else text).strip()


def find(agent_id: str, account_home: str | None = None, cwd: str | None = None) -> dict | None:
    for a in listing(account_home, cwd):
        if a["id"] == agent_id or a["name"] == agent_id:
            return a
    return None


def _one(path: Path, scope: str) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:8000]
    except OSError:
        return None
    h = _header(text)
    name = h.get("name") or path.stem
    seed = sum(ord(c) for c in name)
    return {
        "installed": _app_installed(path),
        "id": f"{scope}:{path.stem}",
        "name": name,
        "label": h.get("label") or name.replace("-", " ").replace("_", " "),
        "description": (h.get("description") or "").strip()[:200],
        "color": _hex(h.get("color")) or COLORS[seed % len(COLORS)],
        "glyph": h.get("glyph") or GLYPHS[seed % len(GLYPHS)],
        "model": h.get("model") or None,
        "scope": scope,
        "path": str(path),
    }


def listing(account_home: str | None = None, cwd: str | None = None) -> list[dict]:
    """Every agent this computer can run, nearest definition first."""
    seen: set[str] = set()
    out: list[dict] = []
    for d, scope in _dirs(account_home, cwd):
        try:
            files = sorted(d.glob("*.md"))
        except OSError:
            continue
        for f in files:
            if f.stem in seen:
                continue
            a = _one(f, scope)
            if a:
                seen.add(f.stem)
                out.append(a)
    out.sort(key=lambda a: a["label"].lower())
    _mark_families(out)
    # The one agent that is always there: it is the way to get the others.
    b = builtin(account_home)
    b["installed"] = True
    return [{k: v for k, v in b.items() if k != "prompt"}] + out


FAMILY_MIN = 3


def _mark_families(items: list[dict]) -> None:
    """Agents that arrived together belong together.

    A tool that ships its own workers drops a dozen files in one go, all named
    with the same prefix. Those are one tool's insides, not a dozen things to
    talk to, so they are tagged as a family and the app shows them as one.
    """
    from collections import Counter
    heads = Counter(a["name"].split("-", 1)[0].lower() for a in items if "-" in a["name"])
    for a in items:
        head = a["name"].split("-", 1)[0].lower()
        a["family"] = head if heads.get(head, 0) >= FAMILY_MIN else None


# ── the store ─────────────────────────────────────────────────────────────
#
# One agent can be installed from outside: Hermes. The list is deliberately
# short — an agent definition is a prompt that runs with this computer's tools,
# so where one comes from is not a detail. Nothing is fetched from anywhere
# else, nothing is executed, and a file that does not parse as an agent is
# refused. Anything else you want, the built-in agent creator writes for you.

SOURCES: list[dict] = [
    {"include": ["skills/"], "branch": "master", "id": "hermes", "repo": "AlexAI-MCP/hermes-CCC",
     "label": "Hermes", "kind": "bundle", "glyph": "🪽", "color": "#7C6BD8",
     "note": "Nous Research's Hermes, ported to Claude Code",
     "about": "One agent with many abilities: it reads the right skill for the job instead of improvising."},
]
_BY_ID = {s["id"]: s for s in SOURCES}
_TREES: dict[str, tuple[float, list[str]]] = {}
_TREE_TTL = 24 * 3600.0
MAX_AGENT_BYTES = 200_000


def _get(url: str, timeout: int = 25, cap: int = MAX_AGENT_BYTES + 1) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "remote-ai-chat",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(cap)


CACHE_DIR = CONFIG_DIR / "agent-store"
SNAPSHOT = Path(__file__).with_name("agent-store-snapshot.json")
_SNAP: dict[str, list[str]] | None = None


def _snapshot() -> dict[str, list[str]]:
    """A file list taken when this version was built. GitHub allows sixty
    unauthenticated requests an hour, and a computer that has spent them — or
    has just been set up — must still be able to show the store."""
    global _SNAP
    if _SNAP is None:
        import json as _json
        try:
            _SNAP = _json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        except Exception:
            _SNAP = {}
    return _SNAP


def _tree(repo: str, branch: str = "main") -> list[str]:
    """The markdown files in a collection.

    GitHub allows sixty unauthenticated requests an hour, so this asks for one
    thing only — the file list — and keeps the answer on disk for a day. A
    restart must not spend the allowance again.
    """
    import json as _json
    import time as _time
    hit = _TREES.get(repo)
    if hit and _time.time() - hit[0] < _TREE_TTL:
        return hit[1]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / (re.sub(r"[^A-Za-z0-9]+", "-", repo) + ".json")
    if cache.exists() and _time.time() - cache.stat().st_mtime < _TREE_TTL:
        try:
            paths = _json.loads(cache.read_text(encoding="utf-8"))
            _TREES[repo] = (_time.time(), paths)
            return paths
        except Exception:
            pass
    try:
        data = _json.loads(_get(
            f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1", cap=12_000_000))
    except Exception as exc:
        if cache.exists():                      # a stale list beats no list
            return _json.loads(cache.read_text(encoding="utf-8"))
        shipped = _snapshot().get(repo)
        if shipped:                             # and a shipped list beats none
            return shipped
        if "403" in str(exc):
            raise Err("store_busy", "GitHub is rate-limiting this computer; try again later")
        raise
    paths = [f"{branch}/{x['path']}" for x in (data.get("tree") or [])
             if x.get("type") == "blob" and str(x.get("path", "")).endswith(".md")]
    cache.write_text(_json.dumps(paths), encoding="utf-8")
    _TREES[repo] = (_time.time(), paths)
    return paths


SKIP = {"readme", "contributing", "license", "changelog", "claude", "agents", "index",
        "readme_ja", "code_of_conduct", "security", "architecture"}


def store(source_id: str = "") -> list[dict]:
    """What can be installed, by collection. One request per collection, cached."""
    out: list[dict] = []
    for s in SOURCES:
        if source_id and s["id"] != source_id:
            continue
        try:
            paths = _tree(s["repo"], s.get("branch", "main"))
        except Exception as exc:
            out.append({**s, "error": str(exc)[:120], "items": []})
            continue
        items = []
        if s.get("kind") == "bundle":
            n = sum(1 for p in paths
                    if any(part in p.split("/", 1)[-1] for part in s.get("include", [])))
            out.append({**s, "items": [{
                "id": f"{s['id']}:*", "label": s["label"], "glyph": s.get("glyph", "🪽"),
                "color": s.get("color", "#7C6BD8"), "repo": s["repo"], "kind": "bundle",
                "skills": n, "about": s.get("about", ""),
            }]})
            continue
        for p in paths:
            stem = p.rsplit("/", 1)[-1][:-3]
            if stem.upper() == "SKILL":
                # the file is always called SKILL.md; the folder is the name
                parts = p.split("/")
                stem = parts[-2] if len(parts) > 1 else stem
            if stem.lower() in SKIP or stem.startswith("."):
                continue
            inside = p.split("/", 1)[1] if "/" in p else p     # drop the branch
            inc = s.get("include", ["/agents/"])
            if inc == [""]:
                if "/" in inside:                               # this one keeps them at the top level
                    continue
            else:
                if "/" not in inside or not any(part in inside for part in inc):
                    continue
            if inside.startswith((".github/", "docs/", "test", "scripts/")):
                continue
            seed = sum(ord(c) for c in stem)
            items.append({
                "id": f"{s['id']}:{p}",
                "label": stem.replace("-", " ").replace("_", " "),
                "glyph": GLYPHS[seed % len(GLYPHS)],
                "color": COLORS[seed % len(COLORS)],
                "repo": s["repo"],
            })
        items.sort(key=lambda x: x["label"])
        out.append({**s, "items": items})
    return out


BUNDLE_AGENT = """You are {NAME}, running inside this tool.

Your abilities are written down as skills, and the tool loads them for you.
Each one is a short guide to doing a particular thing — searching papers,
reviewing a pull request, driving Docker, and so on. When a request matches
one, read that skill and follow it rather than improvising; when none matches,
work it out yourself and say so plainly.

You are one agent with many abilities, not a menu. Do not list your skills at
someone unless they ask what you can do; just do the thing.

Skills available to you: {SKILLS}
"""

# Hermes introduces itself; the quiet default above left people wondering
# whether they were talking to it at all.
HERMES_AGENT = """You are {NAME}, running inside this tool.

Your abilities are written down as skills, and the tool loads them for you.
Each one is a short guide to doing a particular thing — searching papers,
reviewing a pull request, driving Docker, and so on. When a request matches
one, read that skill and follow it rather than improvising; when none matches,
work it out yourself and say so plainly.

Open a new chat by introducing yourself, whatever the first message is — a bare
"hi" counts. Say who you are in a line, name the kinds of work you can take on
(group the skills into a handful of areas, never recite the list), say which
folder you are working in, and ask what the two of you are doing. A few lines:
this is an opening, not a manual. If that first message already carries a real
request, answer it in the same breath — the introduction never costs a turn.

Once you have opened, stop announcing yourself. Do not list your skills again
unless someone asks what you can do; just do the thing.

Skills available to you: {SKILLS}
"""

# Per-source prompt, by source id. Anything without one gets the default.
PROMPTS: dict[str, str] = {"hermes": HERMES_AGENT}


def bundle_file(src: dict, names: list[str]) -> str:
    """The agent definition written for a skill pack, header and all."""
    body = (PROMPTS.get(src["id"], BUNDLE_AGENT)
            .replace("{NAME}", src["label"])
            .replace("{SKILLS}", ", ".join(sorted(names))))
    return (f"---\nname: {src['id']}\n"
            f"description: {src.get('about') or src['label']}\n"
            f"glyph: {src.get('glyph', '🪽')}\ncolor: {src.get('color', '#7C6BD8')}\n---\n\n") + body


def _own_skills_dir(account_home: str | None) -> Path:
    """The same treatment the agents folder gets: an account writes into its
    own place, never into the machine's shared skills."""
    if not account_home:
        # The tool finds skills only in its own settings folder, and for the
        # built-in account that folder is the user's own. Writing forty-six
        # files into it turned every session on the machine into a wall of
        # them. An agent that needs skills needs an account of its own.
        raise Err("needs_own_account",
                  "add an account for this agent: its skills would otherwise be "
                  "written into this computer's own settings")
    root = Path(account_home) / "skills"
    if root.is_symlink():
        shared = root.resolve()
        root.unlink()
        root.mkdir(parents=True, exist_ok=True)
        if shared.is_dir():
            for f in shared.iterdir():
                link = root / f.name
                if not link.exists():
                    try:
                        link.symlink_to(f, target_is_directory=f.is_dir())
                    except OSError:
                        pass
    root.mkdir(parents=True, exist_ok=True)
    return root


def install_bundle(src: dict, account_home: str | None) -> dict:
    """Install a whole agent: every skill it knows, and one definition that is
    the agent itself. Forty-six abilities are not forty-six agents."""
    # Ask for the folder before fetching the tree: without an account this
    # cannot be installed at all, and there is no reason to walk a repo first.
    skills_root = _own_skills_dir(account_home)
    paths = [p for p in _tree(src["repo"], src.get("branch", "main"))
             if any(part in p.split("/", 1)[-1] for part in src.get("include", []))]
    names: list[str] = []
    for p in paths:
        inside = p.split("/", 1)[1]
        name = inside.split("/")[1] if inside.count("/") >= 1 else Path(inside).stem
        raw = f"https://raw.githubusercontent.com/{src['repo']}/{p}"
        try:
            blob = _get(raw)
        except Exception:
            continue
        if len(blob) > MAX_AGENT_BYTES:
            continue
        d = skills_root / re.sub(r"[^A-Za-z0-9_-]", "-", name)[:60]
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_bytes(blob)
        names.append(name)
    if not names:
        raise Err("agent_fetch_failed", "could not download it")
    target = _own_agents_dir(account_home) / f"{src['id']}.md"
    target.write_text(bundle_file(src, names), encoding="utf-8")
    return {"path": str(target), "name": src["id"], "source": src["repo"], "skills": len(names)}


def install(store_id: str, account_home: str | None) -> dict:
    """Fetch one agent definition and put it where the tool looks for agents."""
    src_id, _, path = store_id.partition(":")
    s = _BY_ID.get(src_id)
    if s and s.get("kind") == "bundle":
        return install_bundle(s, account_home)
    if not s or not path.endswith(".md") or ".." in path:
        raise Err("unknown_agent", "that agent is not in the list")
    raw = f"https://raw.githubusercontent.com/{s['repo']}/{path}"
    try:
        blob = _get(raw)
    except Exception as exc:
        raise Err("agent_fetch_failed", f"could not download it: {str(exc)[:80]}")
    if len(blob) > MAX_AGENT_BYTES:
        raise Err("agent_too_big", "that file is too large to be an agent")
    text = blob.decode("utf-8", "replace")
    h = _header(text)
    if not h.get("name") or not h.get("description"):
        raise Err("not_an_agent", "that file is not an agent definition")
    root = _own_agents_dir(account_home)
    stem = re.sub(r"[^A-Za-z0-9_-]", "-", h["name"])[:60] or "agent"
    target = root / f"{stem}.md"
    target.write_text(text, encoding="utf-8")
    return {"path": str(target), "name": h["name"], "source": s["repo"]}


def _own_agents_dir(account_home: str | None) -> Path:
    """A folder this account may write into.

    An account starts with its `agents` entry pointing straight at the
    machine's shared folder, so installing would drop files into the user's own
    Claude Code setup. It is turned into a real folder holding a link per
    shared agent instead: the account still sees all of them, and what this app
    installs stays this app's to remove.

    The built-in account has no folder of its own, and the machine's is off
    limits for the same reason. The CLI never reads these files anyway — the
    daemon hands it the prompt.
    """
    if not account_home:
        DEFAULT_AGENTS.mkdir(parents=True, exist_ok=True)
        return DEFAULT_AGENTS
    root = Path(account_home) / "agents"
    if root.is_symlink():
        shared = root.resolve()
        root.unlink()
        root.mkdir(parents=True, exist_ok=True)
        if shared.is_dir():
            for f in shared.glob("*.md"):
                link = root / f.name
                if not link.exists():
                    try:
                        link.symlink_to(f)
                    except OSError:
                        pass
    root.mkdir(parents=True, exist_ok=True)
    return root


def uninstall(name: str, account_home: str | None) -> bool:
    root = _own_agents_dir(account_home)
    stem = re.sub(r"[^A-Za-z0-9_-]", "-", name)[:60]
    f = root / f"{stem}.md"
    if not f.exists() or f.is_symlink():
        return False
    f.unlink()
    return True


# ── the built-in agent that writes other agents ───────────────────────────

CREATOR_ID = "builtin:agent-creator"

CREATOR_BODY = """You build agents for this app, by talking to the person and then writing the
agent's definition file yourself.

An agent here is one markdown file. Its header gives the agent a name and a
description; everything after the header is the agent's own instructions, which
become that agent's whole personality and method when someone chats with it.

## How to work

Ask one question at a time, and keep each question short. Do not present a
form or a numbered list of everything you need. Start with the only question
that matters:

  What do you want this agent to do?

Then ask only what you still cannot infer, at most four more questions, one per
message. Useful ones, in rough order: who it is for and what a typical request
looks like; what it should never do; how it should sound; whether it needs to
read or write files, run commands, or search the web. If an answer already
tells you the rest, stop asking and say what you are about to build.

Before writing, say in two or three lines what the agent will be, and ask for a
yes. Do not write anything until you have it.

## Writing the file

Write to: {DIR}/<slug>.md

The slug is the name in lowercase with hyphens instead of spaces. Use the Write
tool. The file must start with exactly this header shape, and both fields are
required:

---
name: <slug>
description: <one sentence, under 200 characters, saying when to use this agent>
glyph: <a single emoji that suits it>
color: <a hex colour like #C2522D that suits it>
---

Then the agent's instructions. Write them as instructions to that agent, in the
second person, not as a description of it. Cover: what it is for, how it should
open a conversation, the steps it should follow, what it must refuse or avoid,
and the tone. Two hundred to six hundred words is usually right — long enough
to be a real character, short enough to stay sharp. Write them in the same
language the person has been speaking to you in.

Do not invent tools or commands the computer does not have. If the agent needs
a file to keep its notes in, say where and let it create that file on first use.

After writing, confirm in one line what you made and where, and tell them the
agent appears on the Agents screen and may need a pull to refresh.

## Bounds

Only ever write inside {DIR}. Never edit an agent you did not just create
unless asked to. If someone asks for an agent whose purpose is to deceive
people, impersonate a real person or organisation, or hide what it is doing,
say plainly that you will not build it and offer the nearest honest version.
"""


def builtin(account_home: str | None) -> dict:
    d = str(_own_agents_dir(account_home))
    return {
        "id": CREATOR_ID, "name": "agent-creator", "label": "Agent creator",
        "description": "Asks what you want, then writes an agent for you.",
        "color": "#9A6BD8", "glyph": "✨", "model": None, "scope": "builtin",
        "path": "", "prompt": CREATOR_BODY.replace("{DIR}", d),
    }
