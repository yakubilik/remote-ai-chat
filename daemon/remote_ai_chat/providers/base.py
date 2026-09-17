"""Provider interface: one instance per chat, drives one CLI session."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

# emit(event_type, payload, persist) -> None
EmitFn = Callable[[str, dict, bool], Awaitable[None]]
# approval(tool_name, tool_input, reason) -> "allow" | "allow_session" | "deny"
ApprovalFn = Callable[[str, dict, str | None], Awaitable[str]]


@dataclass
class ProviderConfig:
    model: str
    effort: str | None
    perm_mode: str          # ask | accept-edits | plan | bypass
    cwd: str
    session_id: str | None  # resume
    max_turns: int | None = None
    max_budget_usd: float | None = None
    # Absolute CLI config home for the chosen account (CLAUDE_CONFIG_DIR /
    # CODEX_HOME). None means the machine's own login.
    account_home: str | None = None
    account_id: str | None = None
    # the account's full environment: config-dir pointers and, for an account
    # signed in with a key, the key itself
    account_env: dict[str, str] = field(default_factory=dict)
    # the chat talks to one of the computer's agents: its definition becomes
    # the system prompt, which is what makes the chat that agent
    agent_prompt: str | None = None
    agent_name: str | None = None
    # where this session is and how it is expected to sound. Built per session
    # by preamble.build, because the daemon is the only party that knows.
    preamble: str | None = None


@dataclass
class TurnResult:
    session_id: str | None
    cost_usd: float | None
    usage: dict[str, Any] | None
    duration_ms: int | None
    num_turns: int | None
    is_error: bool = False
    error: str | None = None
    stop_reason: str | None = None


class Provider(ABC):
    name: str = "base"

    def __init__(self, cfg: ProviderConfig, emit: EmitFn, approval: ApprovalFn):
        self.cfg = cfg
        self.emit = emit
        self.approval = approval
        # Called with no turn in flight, when the model has spoken anyway. The
        # session fills this in; it opens a turn for what was said. A provider
        # that cannot be spoken to unasked simply never calls it.
        self.on_idle_output: Callable[[], Awaitable[None]] | None = None

    @abstractmethod
    async def run(self, prompt: str, attachments: list[dict] | None = None) -> TurnResult: ...

    async def run_continuation(self) -> TurnResult:
        """Drain a turn the model started on its own. Only providers that call
        `on_idle_output` are ever asked for one."""
        raise NotImplementedError

    def has_pending(self) -> bool:
        """True when the model has said something no turn has claimed yet."""
        return False

    @abstractmethod
    async def interrupt(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @staticmethod
    @abstractmethod
    def catalog() -> dict: ...
