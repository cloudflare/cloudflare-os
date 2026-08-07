import base64, hashlib, httpx, pytest, time
from urllib.parse import urlparse, parse_qs
from seatproxy import oauth
from seatproxy.refresh import AuthRejected

def test_pkce_challenge_is_s256_of_verifier():
    verifier, challenge = oauth.new_pkce()
    expected = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert challenge == expected
    assert "=" not in challenge and len(verifier) >= 43

def test_pkce_pairs_are_unique():
    assert oauth.new_pkce()[0] != oauth.new_pkce()[0]

def test_anthropic_authorize_url_carries_the_verified_values():
    url = oauth.authorize_url("anthropic", "CHAL", "STATE")
    q = parse_qs(urlparse(url).query)
    assert urlparse(url).netloc == "claude.com"
    assert urlparse(url).path == "/cai/oauth/authorize"
    assert q["client_id"] == ["9d1c250a-e61b-44d9-88ed-5944d1962f5e"]
    assert q["redirect_uri"] == ["https://platform.claude.com/oauth/code/callback"]
    assert q["code_challenge"] == ["CHAL"]
    assert q["code_challenge_method"] == ["S256"]
    assert q["state"] == ["STATE"]
    assert q["response_type"] == ["code"]
    # The full set `claude auth login` requests. Omitting org:create_api_key or
    # user:file_upload renders a consent screen but fails the redirect afterwards,
    # so assert every one of them rather than a representative sample.
    for required in ("org:create_api_key", "user:profile", "user:inference",
                     "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"):
        assert required in q["scope"][0], f"missing scope {required}"

def test_authorize_url_rejects_unknown_provider():
    with pytest.raises(ValueError):
        oauth.authorize_url("bogus", "CHAL", "STATE")

@pytest.mark.asyncio
async def test_exchange_code_posts_verifier_and_returns_absolute_expiry():
    seen = {}
    async def handler(request):
        import json as _json
        seen["body"] = _json.loads(request.content)
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    before = time.time()
    out = await oauth.exchange_code(client, "anthropic", "THECODE", "THEVERIFIER")
    assert (out.access_token, out.refresh_token) == ("A", "R")
    assert before + 3500 < out.expires_at <= time.time() + 3600
    assert seen["body"]["grant_type"] == "authorization_code"
    assert seen["body"]["code"] == "THECODE"
    assert seen["body"]["code_verifier"] == "THEVERIFIER"

@pytest.mark.asyncio
async def test_exchange_code_rejected_raises_auth_rejected():
    async def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(AuthRejected):
        await oauth.exchange_code(client, "anthropic", "BAD", "V")

@pytest.mark.asyncio
async def test_exchange_code_server_error_is_not_auth_rejected():
    async def handler(request):
        return httpx.Response(503, text="down")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        await oauth.exchange_code(client, "anthropic", "C", "V")
    assert not isinstance(exc.value, AuthRejected)

@pytest.mark.asyncio
async def test_device_code_start_returns_user_facing_fields():
    async def handler(request):
        return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                         "verification_uri_complete": "https://x/y",
                                         "interval": 5})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    out = await oauth.start_device_code(client)
    assert out["user_code"] == "ABCD-1234"
    assert out["device_code"] == "DC"

@pytest.mark.asyncio
async def test_device_poll_returns_none_while_pending():
    async def handler(request):
        return httpx.Response(400, json={"error": "authorization_pending"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await oauth.poll_device_code(client, "DC") is None

@pytest.mark.asyncio
async def test_device_poll_returns_tokens_when_authorized():
    async def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 1800})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    out = await oauth.poll_device_code(client, "DC")
    assert out.access_token == "A"

def test_no_secret_appears_in_the_authorize_url():
    verifier, challenge = oauth.new_pkce()
    url = oauth.authorize_url("anthropic", challenge, "STATE")
    assert verifier not in url

@pytest.mark.asyncio
async def test_anthropic_exchange_splits_code_and_state():
    seen = {}
    async def handler(request):
        import json as _json
        seen["body"] = _json.loads(request.content)
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 60})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await oauth.exchange_code(client, "anthropic", "THECODE#THESTATE", "V")
    assert seen["body"]["code"] == "THECODE"
    assert seen["body"]["state"] == "THESTATE"

@pytest.mark.asyncio
async def test_anthropic_exchange_tolerates_a_bare_code():
    seen = {}
    async def handler(request):
        import json as _json
        seen["body"] = _json.loads(request.content)
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 60})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await oauth.exchange_code(client, "anthropic", "  THECODE  ", "V")
    assert seen["body"]["code"] == "THECODE"
    assert "state" not in seen["body"]

def test_anthropic_token_host_is_consistent_across_modules():
    from seatproxy import anthropic_seat
    assert anthropic_seat.TOKEN_URL == oauth.ANTHROPIC_TOKEN_URL
    assert "platform.claude.com" in oauth.ANTHROPIC_TOKEN_URL
