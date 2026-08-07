import json

from . import providers

HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
              "transfer-encoding", "upgrade", "proxy-authorization"}

# Anthropic's OAuth path (the one this relay authenticates through) expects every
# request to identify itself as Claude Code; without this block in `system`, real
# requests get rejected even though the OAuth token itself is valid.
CLAUDE_CODE_IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude."
_CLAUDE_CODE_IDENTITY_BLOCK = {"type": "text", "text": CLAUDE_CODE_IDENTITY_TEXT}

def _is_identity_block(block) -> bool:
    return (isinstance(block, dict) and block.get("type") == "text"
            and block.get("text") == CLAUDE_CODE_IDENTITY_TEXT)

def with_claude_code_identity(body: bytes) -> bytes:
    # Callers we don't control (or don't understand) must never break here: if the body
    # isn't a JSON object we forward it unchanged rather than failing the request.
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body
    if not isinstance(payload, dict):
        return body

    system = payload.get("system")
    if system is None:
        payload["system"] = [_CLAUDE_CODE_IDENTITY_BLOCK]
    elif isinstance(system, str):
        payload["system"] = [_CLAUDE_CODE_IDENTITY_BLOCK, {"type": "text", "text": system}]
    elif isinstance(system, list):
        if system and _is_identity_block(system[0]):
            return body        # already correct; avoid a needless re-serialise
        payload["system"] = [_CLAUDE_CODE_IDENTITY_BLOCK, *system]
    else:
        return body            # unrecognised shape; leave it alone

    return json.dumps(payload).encode("utf-8")

def outbound_headers(provider: str, incoming: dict, access_token: str) -> dict:
    out = {k: v for k, v in incoming.items()
           if k.lower() not in HOP_BY_HOP
           and k.lower() not in {"x-api-key", "authorization"}}
    out["Authorization"] = f"Bearer {access_token}"
    if provider == providers.ANTHROPIC:
        out["anthropic-beta"] = "oauth-2025-04-20"
    else:
        out["Origin"] = "https://chatgpt.com"
        out["Referer"] = "https://chatgpt.com/codex"
        out["User-Agent"] = "Odysseus ChatGPT Subscription"
    return out

from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from .errors import provider_error
from .refresh import resolve_access_token, SeatNeedsReauth, SeatTemporarilyUnavailable

def _read_handle(provider: str, headers) -> str | None:
    if provider == providers.ANTHROPIC:
        return headers.get("x-api-key")
    auth = headers.get("authorization", "")
    return auth[7:] if auth.lower().startswith("bearer ") else None

async def relay(request, provider, upstream_base, store, client, now,
                upstream_path, refresher=None):
    handle = _read_handle(provider, request.headers)
    if not handle:
        return provider_error(provider, 401, "authentication_error", "No credential supplied.")

    # A handle is bound to the provider it was enrolled for. Without this check an
    # Anthropic handle presented on the OpenAI leg would forward a real Anthropic
    # token to chatgpt.com. The message is identical to the unknown-handle case so
    # the response cannot be used to probe which handles exist.
    try:
        rec = store.get(handle)
    except Exception:
        return provider_error(provider, 502, "api_error", "Seat lookup failed.")
    if rec is None or rec.provider != provider:
        return provider_error(provider, 401, "authentication_error",
                              "Your subscription seat needs to be reconnected.")

    try:
        access = await resolve_access_token(
            store, handle, now, refresher or _no_refresh)
    except SeatNeedsReauth:
        return provider_error(provider, 401, "authentication_error",
                              "Your subscription seat needs to be reconnected.")
    except SeatTemporarilyUnavailable:
        return provider_error(provider, 503, "api_error",
                              "Seat temporarily unavailable. Try again shortly.")
    except Exception:
        return provider_error(provider, 502, "api_error", "Seat token refresh failed.")

    # The upstream path is passed in, not derived from request.url.path: the caller
    # mounts this behind a route prefix (/anthropic/..., /openai/...) which must not
    # be forwarded upstream.
    url = upstream_base.rstrip("/") + "/" + upstream_path.lstrip("/")
    if request.url.query:
        url = f"{url}?{request.url.query}"
    body = await request.body()
    if provider == providers.ANTHROPIC:
        body = with_claude_code_identity(body)
    # content-length is in HOP_BY_HOP and so is stripped from the forwarded headers above;
    # httpx computes a fresh one from `content=` below, so it always matches what we send
    # even when with_claude_code_identity() changed the body's length.
    req = client.build_request(
        request.method, url,
        headers=outbound_headers(provider, dict(request.headers), access),
        content=body)
    try:
        upstream = await client.send(req, stream=True)
    except Exception:
        return provider_error(provider, 502, "api_error", "Upstream request failed.")

    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers={k: v for k, v in upstream.headers.items()
                 if k.lower() not in HOP_BY_HOP},
        # httpx auto-closes only on full natural consumption. When the client
        # disconnects mid-stream — every "stop generating" — Starlette cancels the
        # generator before EOF and the connection is never returned to the pool.
        # The BackgroundTask runs on both paths.
        background=BackgroundTask(upstream.aclose))

async def _no_refresh(provider, tokens):
    raise RuntimeError("no refresher configured for this provider")
