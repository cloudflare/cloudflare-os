"""Provider OAuth the proxy drives itself.

Anthropic uses an authorization-code flow whose redirect is an Anthropic-hosted page
that shows the user a code to paste back. OpenAI uses a device-code flow. Neither
needs a CLI on this host. Values are recorded in the spec and were verified against
a live consent screen (Anthropic) and a working implementation in Odysseus (OpenAI).
"""

import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode

import httpx

from . import providers
from .credentials import SeatTokens
from .refresh import AuthRejected

ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
ANTHROPIC_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
ANTHROPIC_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
ANTHROPIC_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"

OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
OPENAI_ISSUER = "https://auth.openai.com"
OPENAI_TOKEN_URL = f"{OPENAI_ISSUER}/oauth/token"
OPENAI_REDIRECT_URI = f"{OPENAI_ISSUER}/deviceauth/callback"
OPENAI_DEVICE_CODE_URL = f"{OPENAI_ISSUER}/oauth/device/code"

def new_pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge

def authorize_url(provider: str, challenge: str, state: str) -> str:
    if provider != providers.ANTHROPIC:
        # OpenAI enrolls through the device flow, which has no authorize URL to build.
        raise ValueError("authorize_url is only defined for Anthropic")
    return ANTHROPIC_AUTHORIZE_URL + "?" + urlencode({
        "code": "true",
        "client_id": ANTHROPIC_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": ANTHROPIC_REDIRECT_URI,
        "scope": ANTHROPIC_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    })

def _tokens_from(data: dict) -> SeatTokens:
    refresh = data.get("refresh_token")
    if not refresh:
        # The credentials file format and the refresh path both require one. Storing
        # an empty refresh token would give a seat that works until first expiry and
        # then reads back as malformed, which is a confusing way to fail.
        raise AuthRejected()
    return SeatTokens(data["access_token"], refresh,
                      time.time() + float(data.get("expires_in", 0)))

def _check(response: httpx.Response) -> dict:
    # 4xx here means the code or verifier was refused; 5xx is transient.
    if response.status_code in (400, 401, 403):
        raise AuthRejected()
    response.raise_for_status()
    return response.json()

async def exchange_code(client: httpx.AsyncClient, provider: str,
                        code: str, verifier: str) -> SeatTokens:
    if provider == providers.ANTHROPIC:
        response = await client.post(ANTHROPIC_TOKEN_URL, json={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": ANTHROPIC_REDIRECT_URI,
            "client_id": ANTHROPIC_CLIENT_ID,
            "code_verifier": verifier,
        })
    else:
        response = await client.post(
            OPENAI_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OPENAI_REDIRECT_URI,
                "client_id": OPENAI_CLIENT_ID,
                "code_verifier": verifier,
            })
    return _tokens_from(_check(response))

async def start_device_code(client: httpx.AsyncClient) -> dict:
    response = await client.post(OPENAI_DEVICE_CODE_URL,
                                 json={"client_id": OPENAI_CLIENT_ID,
                                       "scope": "openid profile email offline_access"})
    response.raise_for_status()
    return response.json()

async def poll_device_code(client: httpx.AsyncClient, device_code: str) -> SeatTokens | None:
    response = await client.post(
        OPENAI_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "urn:ietf:params:oauth:grant-type:device_code",
              "device_code": device_code,
              "client_id": OPENAI_CLIENT_ID})
    if response.status_code >= 400:
        try:
            error = response.json().get("error", "")
        except Exception:
            error = ""
        # Still waiting on the human — not a failure.
        if error in ("authorization_pending", "slow_down"):
            return None
    return _tokens_from(_check(response))
