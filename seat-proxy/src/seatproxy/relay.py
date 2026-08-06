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
from .errors import provider_error
from .refresh import resolve_access_token, SeatNeedsReauth

def _read_handle(provider: str, headers) -> str | None:
    if provider == "anthropic":
        return headers.get("x-api-key")
    auth = headers.get("authorization", "")
    return auth[7:] if auth.lower().startswith("bearer ") else None

async def relay(request, provider, upstream_base, store, client, now, refresher=None):
    handle = _read_handle(provider, request.headers)
    if not handle:
        return provider_error(provider, 401, "authentication_error", "No credential supplied.")
    try:
        access = await resolve_access_token(
            store, handle, now, refresher or _no_refresh)
    except SeatNeedsReauth:
        return provider_error(provider, 401, "authentication_error",
                              "Your subscription seat needs to be reconnected.")

    url = upstream_base.rstrip("/") + request.url.path
    req = client.build_request(
        request.method, url,
        headers=outbound_headers(provider, dict(request.headers), access),
        content=await request.body())
    upstream = await client.send(req, stream=True)

    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers={k: v for k, v in upstream.headers.items()
                 if k.lower() not in HOP_BY_HOP},
        background=None)

async def _no_refresh(rec):
    raise RuntimeError("no refresher configured for this provider")
