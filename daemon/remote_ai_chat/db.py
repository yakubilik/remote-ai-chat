"""SQLite persistence: groups, chats, events (the timeline), plan limits."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0, created_at REAL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  perm_mode TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider_session_id TEXT,
  account_id TEXT,
  status TEXT DEFAULT 'idle',
  last_preview TEXT DEFAULT '',
  max_turns INTEGER,
  max_budget_usd REAL,
  total_cost_usd REAL DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, seq);
CREATE TABLE IF NOT EXISTS limits (
  account_key TEXT NOT NULL,
  window TEXT NOT NULL,
  payload TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (account_key, window)
);
"""


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class DB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._c = sqlite3.connect(str(path), check_same_thread=False)
        self._c.row_factory = sqlite3.Row
        self._c.execute("PRAGMA journal_mode=WAL")
        self._c.executescript(SCHEMA)
        self._migrate()
        cols = {r["name"] for r in self._c.execute("PRAGMA table_info(chats)").fetchall()}
        if "session_ids" not in cols:
            self._c.execute("ALTER TABLE chats ADD COLUMN session_ids TEXT DEFAULT '{}'")
        # Nothing can be running right after start; clear stale states from a crash/restart.
        self._c.execute("UPDATE chats SET status='idle' WHERE status!='idle'")
        self._c.commit()
        self._lock = threading.Lock()
        self._expire_orphan_approvals()

    def _expire_orphan_approvals(self) -> None:
        """Approval requests whose waiting coroutine died with the old process can never
        be answered; mark them expired so the phone stops showing Allow/Deny."""
        rows = self._c.execute(
            "SELECT chat_id, payload FROM events WHERE type='approval.request' ORDER BY seq").fetchall()
        resolved = {json.loads(r["payload"]).get("request_id") for r in self._c.execute(
            "SELECT payload FROM events WHERE type='approval.resolved'").fetchall()}
        for r in rows:
            rid = json.loads(r["payload"]).get("request_id")
            if rid and rid not in resolved:
                self.append_event(r["chat_id"], "approval.resolved", {"request_id": rid, "decision": "expired"})

    def _migrate(self) -> None:
        """Additive column migrations for databases created by older versions."""
        have = {r[1] for r in self._c.execute("PRAGMA table_info(chats)")}
        for col, decl in (("account_id", "TEXT"), ("agent_id", "TEXT")):
            if col not in have:
                self._c.execute(f"ALTER TABLE chats ADD COLUMN {col} {decl}")
        self._c.commit()

    # ── groups ─────────────────────────────────────────────────────────────
    def list_groups(self) -> list[dict]:
        rows = self._c.execute("SELECT * FROM groups ORDER BY sort, created_at").fetchall()
        return [dict(r) for r in rows]

    def create_group(self, name: str) -> dict:
        if any(g["name"].strip().lower() == name.strip().lower() for g in self.list_groups()):
            raise ValueError("a group with that name already exists")
        g = {"id": new_id(), "name": name, "sort": 0, "created_at": time.time()}
        with self._lock:
            self._c.execute("INSERT INTO groups VALUES (:id,:name,:sort,:created_at)", g)
            self._c.commit()
        return g

    def rename_group(self, gid: str, name: str) -> None:
        with self._lock:
            self._c.execute("UPDATE groups SET name=? WHERE id=?", (name, gid))
            self._c.commit()

    def delete_group(self, gid: str) -> None:
        with self._lock:
            self._c.execute("UPDATE chats SET group_id=NULL WHERE group_id=?", (gid,))
            self._c.execute("DELETE FROM groups WHERE id=?", (gid,))
            self._c.commit()

    # ── chats ──────────────────────────────────────────────────────────────
    def list_chats(self, include_archived: bool = False) -> list[dict]:
        q = "SELECT * FROM chats" + ("" if include_archived else " WHERE archived=0")
        q += " ORDER BY pinned DESC, updated_at DESC"
        return [dict(r) for r in self._c.execute(q).fetchall()]

    def get_chat(self, cid: str) -> dict | None:
        r = self._c.execute("SELECT * FROM chats WHERE id=?", (cid,)).fetchone()
        return dict(r) if r else None

    def create_chat(self, **kw: Any) -> dict:
        now = time.time()
        chat = {
            "id": new_id(), "group_id": None, "title": "New chat",
            "provider": "claude", "model": "fable", "effort": "high",
            "perm_mode": "ask", "cwd": "", "provider_session_id": None, "account_id": None,
            "agent_id": None,
            "status": "idle", "last_preview": "", "max_turns": None,
            "max_budget_usd": None, "total_cost_usd": 0.0, "pinned": 0,
            "archived": 0, "created_at": now, "updated_at": now, "session_ids": "{}",
        }
        chat.update({k: v for k, v in kw.items() if k in chat})
        cols = ",".join(chat.keys())
        vals = ",".join(":" + k for k in chat.keys())
        with self._lock:
            self._c.execute(f"INSERT INTO chats ({cols}) VALUES ({vals})", chat)
            self._c.commit()
        return chat

    def update_chat(self, cid: str, **fields: Any) -> dict | None:
        allowed = {"group_id", "title", "provider", "model", "effort", "perm_mode", "cwd",
                   "provider_session_id", "status", "last_preview", "max_turns",
                   "max_budget_usd", "total_cost_usd", "pinned", "archived", "session_ids", "account_id", "agent_id"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return self.get_chat(cid)
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=:{k}" for k in fields)
        fields["id"] = cid
        with self._lock:
            self._c.execute(f"UPDATE chats SET {sets} WHERE id=:id", fields)
            self._c.commit()
        return self.get_chat(cid)

    def touch_chat(self, cid: str, preview: str | None = None) -> None:
        if preview is not None:
            self.update_chat(cid, last_preview=preview[:200])
        else:
            self.update_chat(cid, status=self.get_chat(cid)["status"])

    def delete_chat(self, cid: str) -> None:
        with self._lock:
            self._c.execute("DELETE FROM events WHERE chat_id=?", (cid,))
            self._c.execute("DELETE FROM chats WHERE id=?", (cid,))
            self._c.commit()

    # ── events ─────────────────────────────────────────────────────────────
    def append_event(self, chat_id: str, type_: str, payload: dict) -> dict:
        ts = time.time()
        with self._lock:
            cur = self._c.execute(
                "INSERT INTO events (chat_id,type,payload,ts) VALUES (?,?,?,?)",
                (chat_id, type_, json.dumps(payload, ensure_ascii=False), ts),
            )
            self._c.commit()
            seq = cur.lastrowid
        return {"seq": seq, "chat_id": chat_id, "event": type_, "data": payload, "ts": ts}

    def events(self, chat_id: str, since_seq: int = 0, limit: int = 500) -> list[dict]:
        rows = self._c.execute(
            "SELECT * FROM events WHERE chat_id=? AND seq>? ORDER BY seq LIMIT ?",
            (chat_id, since_seq, limit),
        ).fetchall()
        return [{"seq": r["seq"], "chat_id": r["chat_id"], "event": r["type"],
                 "data": json.loads(r["payload"]), "ts": r["ts"]} for r in rows]

    def tail_events(self, chat_id: str, types: tuple[str, ...], limit: int = 12) -> list[dict]:
        """The newest events of a few kinds, newest first.

        `events()` walks a chat forward from a sequence number, which is what a
        phone rebuilding a timeline wants. Answering "what is it doing right
        now" wants the opposite: the last handful, and only the kinds that say
        anything about the current state.
        """
        if not types:
            return []
        holes = ",".join("?" * len(types))
        rows = self._c.execute(
            f"SELECT * FROM events WHERE chat_id=? AND type IN ({holes}) "
            "ORDER BY seq DESC LIMIT ?",
            (chat_id, *types, limit),
        ).fetchall()
        return [{"seq": r["seq"], "chat_id": r["chat_id"], "event": r["type"],
                 "data": json.loads(r["payload"]), "ts": r["ts"]} for r in rows]

    def last_seq(self, chat_id: str) -> int:
        r = self._c.execute("SELECT MAX(seq) FROM events WHERE chat_id=?", (chat_id,)).fetchone()
        return int(r[0] or 0)

    # ── plan limits ────────────────────────────────────────────────────────
    # The tool reports what is left of the plan only while a turn is running.
    # Keeping the last word on disk is what lets the ring show a number right
    # after a restart, instead of going blank until someone sends a message.

    def save_limits(self, account_key: str, windows: list[dict], at: float) -> None:
        with self._lock:
            self._c.executemany(
                "INSERT INTO limits (account_key, window, payload, at) VALUES (?,?,?,?) "
                "ON CONFLICT(account_key, window) DO UPDATE SET payload=excluded.payload, at=excluded.at",
                [(account_key, str(w.get("window")), json.dumps(w), at) for w in windows],
            )
            self._c.commit()

    def load_limits(self) -> dict[str, dict[str, dict]]:
        out: dict[str, dict[str, dict]] = {}
        for r in self._c.execute("SELECT * FROM limits").fetchall():
            try:
                d = json.loads(r["payload"])
            except Exception:
                continue
            d["at"] = r["at"]
            out.setdefault(r["account_key"], {})[r["window"]] = d
        return out
