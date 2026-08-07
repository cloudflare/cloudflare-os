"""Anthropic subscription-seat refresh.

Constants are Claude Code's own public OAuth client, verified against working
code in OpenWhisperer (src-tauri/src/commands/sdk_cmds.rs:482-489).
"""

import time

import httpx

from .credentials import SeatTokens
from .oauth import ANTHROPIC_TOKEN_URL as TOKEN_URL
from .refresh import AuthRejected

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
UPSTREAM_BASE = "https://api.anthropic.com"

# Anthropic exposes no per-seat model list endpoint, so this is a static catalogue.
# The ids match Cloudflare OS's own SUGGESTED_MODELS entries (workshop-shared/src/api.ts)
# so the UI can resolve display names and context windows.
SEAT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5"]

async def refresh(client: httpx.AsyncClient, tokens: SeatTokens) -> SeatTokens:
    response = await client.post(TOKEN_URL, json={
        "grant_type": "refresh_token",
        "refresh_token": tokens.refresh_token,
        "client_id": CLIENT_ID,
    })
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

async def fetch_available_models(client, access_token: str) -> list[str]:
    return list(SEAT_MODELS)
