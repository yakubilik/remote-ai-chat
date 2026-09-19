"""Dangerous-command detection, path allowlist, secret redaction."""
from __future__ import annotations

import re
from pathlib import Path

DESTRUCTIVE_PATTERNS = [
    re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(/|~|\$HOME|\*)(\s|$)"),
    re.compile(r"\brm\s+-rf\s+\*"),
    re.compile(r"\bsudo\s+rm\b"),
    re.compile(r"\bdd\s+[^|]*\bof=/dev/"),
    re.compile(r"\bmkfs\."),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),
    re.compile(r"\bshutdown\b"),
    re.compile(r"\breboot\b"),
    re.compile(r"\bgit\s+push\s+[^|]*--force\b"),
    re.compile(r"\bgit\s+push\s+[^|]*-f\b(?!\w)"),
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    re.compile(r"security\s+delete-(keychain|generic-password|internet-password)"),
    re.compile(r">\s*/dev/(sd[a-z]|disk\d)"),
    re.compile(r"\blaunchctl\s+(unload|bootout|disable|remove)\b"),
    re.compile(r"\bkillall\s+-9\b"),
    re.compile(r"\bpkill\s+-9?\s*-f\s+remote[-_]ai[-_]chat"),
    re.compile(r"\.remote-ai-chat/(?!uploads/)"),   # daemon config / token store (uploads are fine)
]


def destructive_reason(cmd: str) -> str | None:
    if not cmd:
        return None
    for pat in DESTRUCTIVE_PATTERNS:
        if pat.search(cmd):
            return pat.pattern
    return None


SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\b\d{9,10}:[A-Za-z0-9_\-]{35}\b"),   # telegram bot token
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[=:]\s*['\"]?([A-Za-z0-9_\-/+=]{16,})"),
]


def redact(text: str) -> str:
    if not text:
        return text
    for pat in SECRET_PATTERNS:
        if pat.groups:
            text = pat.sub(lambda m: m.group(0).replace(m.group(m.lastindex), "••••••"), text)
        else:
            text = pat.sub("••••••", text)
    return text


# Files the phone must never be handed even when they sit inside an allowed
# root: keys, credentials, the agent's own environment. The roots are for
# *code*; these are the things that live next to code and are not it.
UNSERVABLE_NAMES = re.compile(
    r"^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keychain(-db)?|jks))$",
    re.IGNORECASE,
)
UNSERVABLE_DIRS = {".git", ".ssh", ".aws", ".gnupg", ".config", ".remote-ai-chat", ".claude", ".codex"}


class PathPolicy:
    def __init__(self, allowed_roots: list[str], denied: list[str]):
        self.roots = [Path(p).expanduser().resolve() for p in allowed_roots]
        self.denied = [Path(p).expanduser().resolve() for p in denied]

    def is_servable(self, path: str | Path) -> bool:
        """May this file be handed to the phone over `/files`?

        Inside an allowed root, outside every denied path, a regular file, and
        not one of the names or folders that hold secrets. Symlinks are
        resolved first, so a link out of the root does not get out.
        """
        try:
            p = Path(path).expanduser().resolve(strict=True)
        except Exception:
            return False
        if not p.is_file():
            return False
        if any(p == d or d in p.parents for d in self.denied):
            return False
        if not any(r in p.parents for r in self.roots):
            return False
        if UNSERVABLE_NAMES.match(p.name):
            return False
        return not any(part in UNSERVABLE_DIRS for part in p.parts)

    def is_allowed_cwd(self, cwd: str) -> bool:
        try:
            p = Path(cwd).expanduser().resolve()
        except Exception:
            return False
        if not p.is_dir():
            return False
        if any(p == d or d in p.parents for d in self.denied):
            return False
        return any(p == r or r in p.parents for r in self.roots)

    def list_projects(self) -> list[dict]:
        out = []
        for r in self.roots:
            if not r.is_dir():
                continue
            for child in sorted(r.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    out.append({"path": str(child), "name": child.name,
                                "is_git": (child / ".git").exists()})
        return out
