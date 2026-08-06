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

import asyncio, httpx, pytest
from cryptography.fernet import Fernet
from seatproxy.store import TokenStore
from seatproxy.relay import relay

class FakeRequest:
    def __init__(self, headers, body):
        self.headers, self._body, self.url = headers, body, httpx.URL("http://p/v1/messages")
        self.method = "POST"
    async def body(self):
        return self._body

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
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    h = store.put("alice", "anthropic", "ACCESS", "R", 10_000.0)
    chunks_out = [b"data: a\n\n", b"data: b\n\n", b"data: c\n\n"]

    async def handler(request):
        assert request.headers["authorization"] == "Bearer ACCESS"
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              stream=_Stream(chunks_out))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0)
    received = [c async for c in resp.body_iterator]
    assert received == chunks_out

@pytest.mark.asyncio
async def test_upstream_429_passes_through_with_status(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    h = store.put("alice", "anthropic", "ACCESS", "R", 10_000.0)

    async def handler(request):
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "slow down"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await relay(FakeRequest({"x-api-key": h}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0)
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "30"

@pytest.mark.asyncio
async def test_unknown_handle_returns_anthropic_shaped_401(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    resp = await relay(FakeRequest({"x-api-key": "nope"}, b"{}"), "anthropic",
                       "https://api.anthropic.com", store, client, now=5_000.0)
    assert resp.status_code == 401
    import json
    assert json.loads(resp.body)["type"] == "error"
