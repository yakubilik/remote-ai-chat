#!/usr/bin/env python3
"""The provider against the real CLI, not a scripted stand-in.

    python scripts/test_live.py        # spawns a real claude process

A smoke test: a real turn completes, answers the question actually asked, and
leaves nothing pending behind it.

Be clear about what this does NOT cover. It was written to catch the
`has_pending()` regression and it does not — it passes just as happily with the
old "the inbox is not empty" version, because a plain turn leaves the inbox
plain empty. The regression needed a background agent still talking after the
turn that launched it ended, and that lives in
`test_stream.scenario_background_agent_is_not_a_turn`, where it can be staged
deterministically instead of hoping a live model launches a helper.

So: this file proves the provider still works end to end. It does not guard the
bug. Do not read a pass here as one.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_ai_chat.providers.base import ProviderConfig        # noqa: E402
from remote_ai_chat.providers.claude import ClaudeProvider      # noqa: E402

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        failures += 1


async def main() -> None:
    said: list[str] = []

    async def emit(event: str, data: dict, persist: bool) -> None:
        if event == "message.assistant":
            said.append(data.get("text", ""))

    async def approval(*a, **kw):  # noqa: ANN002, ANN003
        return "allow"

    cfg = ProviderConfig(model="haiku", effort=None, perm_mode="bypass",
                         cwd=str(Path.home()), session_id=None)
    p = ClaudeProvider(cfg, emit, approval)

    print("\na real turn, and what the CLI keeps saying after it")
    try:
        res = await p.run("Reply with exactly: ALPHA. Nothing else.")
        check(not res.error, "the turn completed", f"error={res.error}")
        check(any("ALPHA" in t for t in said), "and answered the question asked",
              f"said={said!r}")

        # The regression lived here. Let the CLI send whatever follows a
        # finished turn, then ask the question the session asks after every turn.
        await asyncio.sleep(5)
        check(not p.has_pending(),
              "nothing is pending once the turn is done",
              f"_spoken={p._spoken} qsize={p._inbox.qsize()}")

        # A second turn must answer itself, not repeat the first.
        said.clear()
        res = await p.run("Reply with exactly: BETA. Nothing else.")
        check(not res.error, "the second turn completed", f"error={res.error}")
        check(any("BETA" in t for t in said) and not any("ALPHA" in t for t in said),
              "the second question gets its own answer", f"said={said!r}")

        await asyncio.sleep(5)
        check(not p.has_pending(), "and still nothing is pending",
              f"_spoken={p._spoken} qsize={p._inbox.qsize()}")
    finally:
        await p.close()

    print("\nall checks passed" if not failures else f"\n{failures} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
