"""Expo push notifications. Content-free by design: no message text leaves the Mac."""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger("rac.push")
EXPO_URL = "https://exp.host/--/api/v2/push/send"


async def send_push(tokens: list[str], title: str, body: str, data: dict | None = None) -> None:
    tokens = [t for t in tokens if t and t.startswith("ExponentPushToken")]
    if not tokens:
        return
    msgs = [{"to": t, "title": title, "body": body, "data": data or {}, "sound": "default"}
            for t in tokens]
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(EXPO_URL, json=msgs)
            if r.status_code >= 300:
                log.warning("expo push failed: %s %s", r.status_code, r.text[:200])
    except Exception as exc:
        log.warning("expo push error: %s", exc)
