"""Errors the phone will see.

Every message the daemon sends to the app is English, and carries a stable
`code` next to it. The app looks the code up in its own translation table, so
the user reads one language, not two; the English text is the fallback for a
code the app does not know yet (older app, newer daemon).
"""
from __future__ import annotations


class Err(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
