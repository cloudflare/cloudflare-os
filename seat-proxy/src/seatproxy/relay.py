HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
              "transfer-encoding", "upgrade", "proxy-authorization"}

def outbound_headers(provider: str, incoming: dict, access_token: str) -> dict:
    out = {k: v for k, v in incoming.items()
           if k.lower() not in HOP_BY_HOP
           and k.lower() not in {"x-api-key", "authorization"}}
    out["Authorization"] = f"Bearer {access_token}"
    if provider == "anthropic":
        out["anthropic-beta"] = "oauth-2025-04-20"
    else:
        out["Origin"] = "https://chatgpt.com"
        out["Referer"] = "https://chatgpt.com/codex"
        out["User-Agent"] = "Odysseus ChatGPT Subscription"
    return out

from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from .errors import provider_error
from .refresh import resolve_access_token, SeatNeedsReauth

def _read_handle(provider: str, headers) -> str | None:
    if provider == "anthropic":
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
    except Exception:
        return provider_error(provider, 502, "api_error", "Seat token refresh failed.")

    # The upstream path is passed in, not derived from request.url.path: the caller
    # mounts this behind a route prefix (/anthropic/..., /openai/...) which must not
    # be forwarded upstream.
    url = upstream_base.rstrip("/") + "/" + upstream_path.lstrip("/")
    if request.url.query:
        url = f"{url}?{request.url.query}"
    req = client.build_request(
        request.method, url,
        headers=outbound_headers(provider, dict(request.headers), access),
        content=await request.body())
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

async def _no_refresh(rec):
    raise RuntimeError("no refresher configured for this provider")
