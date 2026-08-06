import httpx, pytest, time
from seatproxy.credentials import SeatTokens
from seatproxy.refresh import AuthRejected
from seatproxy import openai_seat as o

def test_constants_match_the_verified_values():
    assert o.CLIENT_ID == "app_EMoamEEZ73f0CkXaXp7hrann"
    assert o.TOKEN_URL == "https://auth.openai.com/oauth/token"
    assert o.UPSTREAM_BASE == "https://chatgpt.com/backend-api/codex"

def test_client_headers_look_like_the_codex_client():
    h = o.client_headers("ACCESS")
    assert h["Authorization"] == "Bearer ACCESS"
    assert h["Origin"] == "https://chatgpt.com"
    assert h["Referer"] == "https://chatgpt.com/codex"

@pytest.mark.asyncio
async def test_refresh_posts_form_encoded_and_returns_absolute_expiry():
    async def handler(request):
        assert request.headers["content-type"].startswith(
            "application/x-www-form-urlencoded")
        assert b"grant_type=refresh_token" in request.content
        assert b"app_EMoamEEZ73f0CkXaXp7hrann" in request.content
        return httpx.Response(200, json={"access_token": "NEW", "refresh_token": "NEWR",
                                         "expires_in": 1800})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    before = time.time()
    out = await o.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert (out.access_token, out.refresh_token) == ("NEW", "NEWR")
    assert before + 1700 < out.expires_at <= time.time() + 1800

@pytest.mark.asyncio
async def test_rejected_refresh_raises_auth_rejected():
    async def handler(request):
        return httpx.Response(401, json={"error": "invalid_grant"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(AuthRejected):
        await o.refresh(client, SeatTokens("OLD", "OLDR", 0.0))

@pytest.mark.asyncio
async def test_server_error_is_not_auth_rejected():
    async def handler(request):
        return httpx.Response(500, text="boom")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        await o.refresh(client, SeatTokens("OLD", "OLDR", 0.0))
    assert not isinstance(exc.value, AuthRejected)

@pytest.mark.asyncio
async def test_models_uses_browser_headers_and_reads_slugs():
    async def handler(request):
        assert request.headers["origin"] == "https://chatgpt.com"
        assert request.headers["authorization"] == "Bearer ACCESS"
        return httpx.Response(200, json={"models": [{"slug": "gpt-5-codex"}]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await o.fetch_available_models(client, "ACCESS") == ["gpt-5-codex"]

@pytest.mark.asyncio
async def test_models_returns_empty_list_when_endpoint_fails():
    async def handler(request):
        return httpx.Response(500, text="boom")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await o.fetch_available_models(client, "ACCESS") == []
