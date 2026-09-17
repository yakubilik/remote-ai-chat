#!/usr/bin/env python3
"""A session knows where it is, and does not answer a simple question at length.

    python scripts/test_preamble.py            # offline checks only
    python scripts/test_preamble.py --live     # also spawns a real claude

What is being guarded here is a wrong answer that looked like a right one: a
session introduced itself as some other chat bridge on the same machine, because
the only note about how it was reached described that bridge and nothing
contradicted it. The offline checks prove the daemon states the truth; the live
ones prove a model reads it instead of repeating the older story.

The style checks are deliberately loose. Nothing here counts sentences — the
rule is proportionality, and the only thing a test can honestly catch is the
extreme: a greeting answered with an essay.
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat import preamble                             # noqa: E402
from remote_ai_chat.config import Config                        # noqa: E402
from remote_ai_chat.providers.base import ProviderConfig        # noqa: E402
from remote_ai_chat.providers.claude import ClaudeProvider      # noqa: E402

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        failures += 1


def a_config() -> Config:
    cfg = Config.load()
    cfg.host_name = "Test-Machine.local"
    cfg.allowed_roots = ["/Users/test/projects"]
    cfg.approval_timeout_s = 900
    cfg.idle_disconnect_s = 1800
    return cfg


def a_provider_config(**kw) -> ProviderConfig:
    base = dict(model="opus", effort="high", perm_mode="bypass",
                cwd="/Users/test/projects/thing", session_id=None,
                account_id="claude-abc123")
    base.update(kw)
    return ProviderConfig(**base)


def offline() -> None:
    print("\nthe facts the daemon states about the session")
    text = preamble.build(a_config(), a_provider_config(), "claude")
    for label, needle in [
        ("the host it runs on", "Test-Machine.local"),
        ("the app it is reached through", "remote-ai-chat"),
        ("the account it opened", "claude-abc123"),
        ("the model", "opus"),
        ("the working directory", "/Users/test/projects/thing"),
        ("the roots it may reach", "/Users/test/projects"),
        ("when an approval expires", "900s"),
        ("when an idle chat closes", "1800s"),
        ("that it is not some other bridge", "not any other bridge or bot"),
        ("where the detail lives", "docs/session-context.md"),
    ]:
        check(needle in text, label, f"missing {needle!r}")

    print("\nthe style rides along, and a missing one costs nothing")
    check("<house-style>" in text, "the house style is included")
    check("Lead with the answer" in text, "and is the file's actual content")
    real, preamble.STYLE_PATH = preamble.STYLE_PATH, Path("/nonexistent/house_style.md")
    try:
        bare = preamble.build(a_config(), a_provider_config(), "claude")
        check("<session-context>" in bare and "<house-style>" not in bare,
              "an unreadable style file drops the block, not the session")
    finally:
        preamble.STYLE_PATH = real

    print("\nan account that is the computer's own login still reads")
    anon = preamble.build(a_config(), a_provider_config(account_id=None), "claude")
    check("the computer's own login" in anon, "it says so rather than showing None")

    print("\nthe provider prepends it without losing the agent")
    p = ClaudeProvider(a_provider_config(preamble="CONTEXT-BLOCK",
                                        agent_prompt="AGENT-DEFINITION"),
                       None, None)
    sp = p._options().system_prompt
    append = (sp or {}).get("append", "")
    check(sp and sp.get("preset") == "claude_code", "the preset is still the base prompt")
    check("CONTEXT-BLOCK" in append, "the context is there")
    check("AGENT-DEFINITION" in append, "so is the agent's own definition")
    check(append.index("CONTEXT-BLOCK") < append.index("AGENT-DEFINITION"),
          "context first, agent last — the more specific instruction wins")

    print("\nand a chat with no agent still gets the context")
    p = ClaudeProvider(a_provider_config(preamble="CONTEXT-BLOCK"), None, None)
    check("CONTEXT-BLOCK" in (p._options().system_prompt or {}).get("append", ""),
          "no agent is not a reason to leave a session lost")

    print("\nthe session builds one for every chat it starts")
    src = (Path(__file__).resolve().parents[1] / "remote_ai_chat/session.py").read_text(encoding="utf-8")
    check("preamble.build(self.cfg, pc" in src, "session._make_provider fills it in")


async def live() -> None:
    said: list[str] = []

    async def emit(event: str, data: dict, persist: bool) -> None:
        if event == "message.assistant":
            said.append(data.get("text", ""))

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = a_provider_config(model="haiku", effort=None, cwd=str(Path.home()))
    cfg.preamble = preamble.build(Config.load(), cfg, "claude")
    p = ClaudeProvider(cfg, emit, approval)

    try:
        print("\nasked how it is being reached, in Turkish")
        res = await p.run("sana nerden yazıyorum ben? kısaca söyle")
        answer = " ".join(said).lower()
        check(not res.error, "the turn completed", f"error={res.error}")
        check(bool(re.search(r"remote[- ]?ai[- ]?chat|uygulama|app|telefon", answer)),
              "it names the app it is actually reached through", f"said={answer[:200]!r}")
        # Any other chat bridge sharing this machine is the wrong answer; the
        # session must name the app it is actually reached through.
        claims_other = re.search(r"telegram|whatsapp|discord|slack", answer)
        check(not claims_other, "it does not claim some other bridge",
              f"said={answer[:200]!r}")

        print("\na greeting is not a subject")
        said.clear()
        res = await p.run("naber")
        reply = " ".join(said).strip()
        check(not res.error, "the turn completed", f"error={res.error}")
        check(len(reply) < 400, "a greeting gets a greeting back",
              f"{len(reply)} chars: {reply[:200]!r}")
        check(not re.search(r"yapay zeka|asistan|size nasıl yardımcı", reply.lower()),
              "and no assistant boilerplate", f"said={reply[:200]!r}")
    finally:
        await p.close()


async def main() -> None:
    offline()
    if "--live" in sys.argv:
        await live()
    else:
        print("\n(skipping live checks; pass --live to spawn a real claude)")
    print("\nall checks passed" if not failures else f"\n{failures} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
