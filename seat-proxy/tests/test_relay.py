from seatproxy.relay import outbound_headers

def test_anthropic_strips_api_key_and_adds_oauth_headers():
    out = outbound_headers("anthropic",
        {"x-api-key": "HANDLE", "anthropic-version": "2023-06-01", "content-type": "application/json"},
        "ACCESS")
    assert "x-api-key" not in {k.lower() for k in out}
    assert out["Authorization"] == "Bearer ACCESS"
    assert out["anthropic-beta"] == "oauth-2025-04-20"
    assert out["anthropic-version"] == "2023-06-01"

def test_openai_replaces_bearer_and_sets_client_headers():
    out = outbound_headers("openai", {"authorization": "Bearer HANDLE"}, "ACCESS")
    assert out["Authorization"] == "Bearer ACCESS"
    assert out["Origin"] == "https://chatgpt.com"
    assert out["Referer"] == "https://chatgpt.com/codex"

def test_hop_by_hop_headers_are_dropped():
    out = outbound_headers("anthropic",
        {"x-api-key": "H", "host": "proxy.local", "content-length": "12",
         "connection": "keep-alive"}, "ACCESS")
    lowered = {k.lower() for k in out}
    assert "host" not in lowered and "content-length" not in lowered
    assert "connection" not in lowered

def test_handle_never_appears_in_outbound_headers():
    out = outbound_headers("anthropic", {"x-api-key": "SECRET-HANDLE"}, "ACCESS")
    assert "SECRET-HANDLE" not in " ".join(f"{k}{v}" for k, v in out.items())

import asyncio, httpx, json, pytest
from seatproxy.store import SeatStore
from seatproxy.relay import relay

class FakeRequest:
    def __init__(self, headers, body):
        self.headers, self._body, self.url = headers, body, httpx.URL("http://p/v1/messages")
        self.method = "POST"
    async def body(self):
        return self._body

def _enrolled_seat(store, tmp_path, owner="alice", provider="anthropic", access_token="ACCESS",
                    expires_at_ms=99_999_999_999_000):
    # relay() resolves the access token from the provider CLI's credentials file,
    # so any test that expects the relay to succeed needs one seeded — a bare
    # config_dir raises SeatNeedsReauth before the request reaches the upstream.
    cfg = tmp_path / "cfg"
    cfg.mkdir(exist_ok=True)
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": access_token, "refreshToken": "R",
                           "expiresAt": expires_at_ms}}), encoding="utf-8")
    return store.put(owner, provider, str(cfg))

# httpx.AsyncByteStream is an abstract base class in this httpx version and cannot
# be constructed directly with `AsyncByteStream(gen())` (raises TypeError: takes no
# arguments). Use a tiny concrete subclass instead; assertions are unchanged.
class _Stream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self._chunks = chunks
    async def __aiter__(self):
        for c in self._chunks:
            yield c

@pytest.mark.asyncio
async def test_streams_incrementally_without_buffering(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path)
    chunks_out = [b"data: a\n\n", b"data: b\n\n", b"data: c\n\n"]

    async def handler(request):
        assert request.headers["authorization"] == "Bearer ACCESS"
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              stream=_Stream(chunks_out))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0,
                       upstream_path="v1/messages")
    received = [c async for c in resp.body_iterator]
    assert received == chunks_out

@pytest.mark.asyncio
async def test_upstream_429_passes_through_with_status(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path)

    async def handler(request):
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "slow down"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0,
                       upstream_path="v1/messages")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "30"

@pytest.mark.asyncio
async def test_unknown_handle_returns_anthropic_shaped_401(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    resp = await relay(FakeRequest({"x-api-key": "nope"}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0,
                       upstream_path="v1/messages")
    assert resp.status_code == 401
    import json
    assert json.loads(resp.body)["type"] == "error"

@pytest.mark.asyncio
async def test_upstream_response_is_closed_after_streaming(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path)

    async def handler(request):
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0,
                       upstream_path="v1/messages")
    assert resp.background is not None

@pytest.mark.asyncio
async def test_route_prefix_is_not_forwarded_upstream(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path)
    seen = {}

    async def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    req = FakeRequest({"x-api-key": h}, b"{}")
    req.url = httpx.URL("http://p/anthropic/v1/messages")
    await relay(req, "anthropic", "https://api.anthropic.com", store, client,
                now=5_000.0, upstream_path="v1/messages")
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert "/anthropic/v1/messages" not in seen["url"]

@pytest.mark.asyncio
async def test_handle_from_other_provider_is_refused(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", str(tmp_path / "cfg"))
    called = {"upstream": False}

    async def handler(request):
        called["upstream"] = True
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"authorization": f"Bearer {h}"}, b"{}"),
                       "openai", "https://chatgpt.com/backend-api/codex",
                       store, client, now=5_000.0, upstream_path="responses")
    assert resp.status_code == 401
    assert called["upstream"] is False

@pytest.mark.asyncio
async def test_upstream_connection_error_returns_provider_shaped_502(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path)

    async def handler(request):
        raise httpx.ConnectError("upstream down")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client,
                       now=5_000.0, upstream_path="v1/messages")
    assert resp.status_code == 502
    import json as _json
    body = _json.loads(resp.body)
    assert body["type"] == "error"
    assert "detail" not in body

@pytest.mark.asyncio
async def test_missing_refresher_does_not_typeerror(tmp_path):
    # The default refresher must match the (provider, tokens) contract, or an
    # expired seat with no refresher wired would raise TypeError instead of a
    # clean provider-shaped response.
    store = SeatStore(str(tmp_path / "s.db"))
    h = _enrolled_seat(store, tmp_path, expires_at_ms=0)

    async def handler(request):
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client,
                       now=5_000.0, upstream_path="v1/messages")
    assert resp.status_code in (401, 502, 503)
