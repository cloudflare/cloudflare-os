"""ChatGPT/Codex subscription-seat refresh.

Constants ported from Odysseus (src/chatgpt_subscription.py:20-28, 78-87), which
has a working implementation of this flow.
"""

import time

import httpx

from .credentials import SeatTokens
from .refresh import AuthRejected

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_URL = "https://auth.openai.com/oauth/token"
UPSTREAM_BASE = "https://chatgpt.com/backend-api/codex"

def client_headers(access_token: str | None) -> dict:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/codex",
        "User-Agent": "seat-proxy",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    return headers

async def refresh(client: httpx.AsyncClient, tokens: SeatTokens) -> SeatTokens:
    response = await client.post(
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token",
              "refresh_token": tokens.refresh_token,
              "client_id": CLIENT_ID})
    # Only a genuine credential rejection means the seat is dead. 408 and 429 are
    # transient and must not brick a seat, and anything else 4xx falls through to
    # raise_for_status() and is treated as transient by the caller.
    if response.status_code in (400, 401, 403):
        raise AuthRejected()
    response.raise_for_status()
    data = response.json()
    return SeatTokens(
        data["access_token"],
        data.get("refresh_token") or tokens.refresh_token,
        time.time() + float(data["expires_in"]),
    )

async def fetch_available_models(client: httpx.AsyncClient, access_token: str) -> list[str]:
    # A seat with no discoverable catalogue is still usable with a model typed by
    # hand, so a failure here must not block enrollment.
    try:
        response = await client.get(f"{UPSTREAM_BASE}/models",
                                    headers=client_headers(access_token))
        response.raise_for_status()
        return [m["slug"] for m in response.json().get("models", [])]
    except Exception:
        return []
