import httpx, pytest, time
from seatproxy.credentials import SeatTokens
from seatproxy.refresh import AuthRejected
from seatproxy import anthropic_seat as a

def test_constants_match_the_verified_values():
    assert a.CLIENT_ID == "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    assert a.TOKEN_URL == "https://console.anthropic.com/v1/oauth/token"
    assert a.UPSTREAM_BASE == "https://api.anthropic.com"

@pytest.mark.asyncio
async def test_refresh_posts_json_and_returns_absolute_expiry():
    async def handler(request):
        import json
        body = json.loads(request.content)
        assert body == {"grant_type": "refresh_token", "refresh_token": "OLDR",
                        "client_id": a.CLIENT_ID}
        return httpx.Response(200, json={"access_token": "NEW", "refresh_token": "NEWR",
                                         "expires_in": 3600})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    before = time.time()
    out = await a.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert (out.access_token, out.refresh_token) == ("NEW", "NEWR")
    assert before + 3500 < out.expires_at <= time.time() + 3600

@pytest.mark.asyncio
async def test_refresh_keeps_old_refresh_token_when_not_rotated():
    async def handler(request):
        return httpx.Response(200, json={"access_token": "NEW", "expires_in": 60})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    out = await a.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert out.refresh_token == "OLDR"

@pytest.mark.asyncio
async def test_rejected_refresh_raises_auth_rejected():
    async def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(AuthRejected):
        await a.refresh(client, SeatTokens("OLD", "OLDR", 0.0))

@pytest.mark.asyncio
async def test_server_error_is_not_auth_rejected():
    async def handler(request):
        return httpx.Response(503, text="upstream down")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        await a.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert not isinstance(exc.value, AuthRejected)

@pytest.mark.asyncio
async def test_models_returns_the_seat_catalog():
    assert "claude-sonnet-5" in await a.fetch_available_models(None, "ACCESS")

@pytest.mark.asyncio
async def test_rate_limited_refresh_is_transient_not_auth_rejected():
    async def handler(request):
        return httpx.Response(429, json={"error": "slow_down"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        await a.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert not isinstance(exc.value, AuthRejected)
