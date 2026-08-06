# Seat Proxy — Web OAuth Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CLI-login enrollment with OAuth the proxy drives itself, so nobody needs shell access to the host and the provider CLIs need not be installed there.

**Architecture:** The proxy generates a PKCE pair and hands the user a provider consent URL. Anthropic returns a code the user pastes back; OpenAI uses a device flow the proxy polls. Either way the proxy exchanges for tokens and writes them into the CLI's own credentials-file format, so every existing module downstream is unchanged.

**Tech Stack:** Python 3.13, FastAPI, httpx, pytest.

**Supersedes:** the `start`/`poll` endpoints from `2026-08-06-seat-proxy-cli-pivot.md` Task 7. Everything else from that plan stands.

## Global Constraints

- Python 3.13. Work only in `C:\Developer\cloudflare-os\seat-proxy\`. Never commit `.pyc`. No venv, no pip install.
- **Never log or return a token, a PKCE verifier, or an authorization code.** Exceptions carry no tokens, codes, verifiers, or filesystem paths.
- **The verifier never leaves the server.** The client receives only an opaque `enroll_id` and the authorize URL.
- Credentials files are created `0600` (`os.open` before write, then `os.replace`) — `os.replace` makes the destination inherit the temp file's mode.
- Existing modules `store.py`, `refresh.py`, `relay.py`, `errors.py`, `providers.py`, `anthropic_seat.py`, `openai_seat.py` are reviewed and must not be modified except where a task says so explicitly.
- Suite is currently 98 passed, 1 skipped. Never weaken an existing assertion.

### Verified provider values

Anthropic — **live-tested 2026-08-06, returns a real consent screen**:

| | |
|---|---|
| client_id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| authorize | `https://claude.com/cai/oauth/authorize` |
| token | `https://platform.claude.com/v1/oauth/token` |
| redirect_uri | `https://platform.claude.com/oauth/code/callback` |
| scopes | `user:profile user:inference user:sessions:claude_code user:mcp_servers` |
| extra query | `code=true`, PKCE S256 |

OpenAI — from the working implementation in `C:\Developer\odysseus\src\chatgpt_subscription.py:20-28, 168-212`:

| | |
|---|---|
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` |
| issuer | `https://auth.openai.com` |
| token | `https://auth.openai.com/oauth/token` |
| redirect_uri | `https://auth.openai.com/deviceauth/callback` |
| flow | device code, then poll |

---

### Task 1: Credentials creation path

`write_tokens` deliberately refuses to create a missing file — that was a hardening fix, because
fabricating one masks a wrong `config_dir`. Enrollment legitimately needs to create the first one,
so it gets its own explicit function rather than a flag that weakens the existing guarantee.

**Files:**
- Modify: `seat-proxy/src/seatproxy/credentials.py`
- Modify: `seat-proxy/tests/test_credentials.py`

**Interfaces:**
- Produces: `create_tokens(provider: str, config_dir: str, tokens: SeatTokens) -> None`.

- [ ] **Step 1: Write the failing test**

```python
# append to seat-proxy/tests/test_credentials.py
def test_create_tokens_writes_a_new_file(tmp_path):
    from seatproxy.credentials import create_tokens
    cfg = tmp_path / "seat"
    cfg.mkdir()
    create_tokens("anthropic", str(cfg), SeatTokens("A", "R", 5000.0))
    doc = json.loads((cfg / ".credentials.json").read_text(encoding="utf-8"))
    assert doc["claudeAiOauth"]["accessToken"] == "A"
    assert doc["claudeAiOauth"]["refreshToken"] == "R"
    assert doc["claudeAiOauth"]["expiresAt"] == 5_000_000

def test_create_tokens_overwrites_an_existing_file(tmp_path):
    from seatproxy.credentials import create_tokens
    write_claude(tmp_path, access="OLD")
    create_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    doc = json.loads((tmp_path / ".credentials.json").read_text(encoding="utf-8"))
    assert doc["claudeAiOauth"]["accessToken"] == "NEW"

def test_create_tokens_writes_codex_shape(tmp_path):
    from seatproxy.credentials import create_tokens
    cfg = tmp_path / "seat"
    cfg.mkdir()
    create_tokens("openai", str(cfg), SeatTokens("A", "R", 5000.0))
    doc = json.loads((cfg / "auth.json").read_text(encoding="utf-8"))
    assert doc["tokens"]["access_token"] == "A"
    assert doc["tokens"]["refresh_token"] == "R"
    assert doc["expires_at"] == 5000.0

@pytest.mark.skipif(os.name == "nt",
                    reason="POSIX file modes are not enforced on Windows")
def test_create_tokens_file_is_owner_only(tmp_path):
    from seatproxy.credentials import create_tokens
    cfg = tmp_path / "seat"
    cfg.mkdir()
    create_tokens("anthropic", str(cfg), SeatTokens("A", "R", 1.0))
    assert (cfg / ".credentials.json").stat().st_mode & 0o777 == 0o600

def test_write_tokens_still_refuses_a_missing_file(tmp_path):
    with pytest.raises(CredentialsMissing):
        write_tokens("anthropic", str(tmp_path), SeatTokens("A", "R", 1.0))
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_credentials.py -v`
Expected: FAIL with `ImportError: cannot import name 'create_tokens'`

- [ ] **Step 3: Refactor the shared write, then add `create_tokens`**

In `credentials.py`, extract the document-building and atomic-write half of `write_tokens` into a
private helper, and have both public functions use it. Replace `write_tokens` with:

```python
def _apply(provider: str, raw: dict, tokens: SeatTokens) -> dict:
    if provider == providers.ANTHROPIC:
        node = raw.setdefault("claudeAiOauth", {})
        node["accessToken"] = tokens.access_token
        node["refreshToken"] = tokens.refresh_token
        node["expiresAt"] = int(tokens.expires_at * 1000)
    else:
        node = raw.setdefault("tokens", {})
        node["access_token"] = tokens.access_token
        node["refresh_token"] = tokens.refresh_token
        raw["expires_at"] = tokens.expires_at
    return raw

def _atomic_write(provider: str, config_dir: str, raw: dict) -> None:
    # The temp file is created 0600 because os.replace makes the DESTINATION inherit
    # the temp file's mode — a default-mode temp would silently downgrade the user's
    # credentials file to world-readable and expose a durable refresh token to every
    # other account on the host.
    path = credentials_path(provider, config_dir)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(raw, indent=2))
    os.replace(tmp, path)

def write_tokens(provider: str, config_dir: str, tokens: SeatTokens) -> None:
    # The CLI's file is authoritative, so refuse to fabricate one. A missing or
    # unparseable file means the config_dir is wrong or the login never completed;
    # silently creating a fresh file there would mask that, and leave the user's
    # real credentials un-rotated while we believe the write succeeded.
    _atomic_write(provider, config_dir, _apply(provider, _load(provider, config_dir), tokens))

def create_tokens(provider: str, config_dir: str, tokens: SeatTokens) -> None:
    """Write the FIRST credentials file for a freshly enrolled seat.

    Separate from write_tokens, which refuses to create a missing file so that a
    wrong config_dir cannot be masked. Enrollment is the one caller that legitimately
    has nothing to merge into.
    """
    _atomic_write(provider, config_dir, _apply(provider, {}, tokens))
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_credentials.py -v`
Then: `python -m pytest -q`
Expected: the credentials file gains 5 tests; whole suite still green apart from the known skip.

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/credentials.py seat-proxy/tests/test_credentials.py
git commit -m "feat(seat-proxy): explicit credentials-creation path for enrollment"
```

---

### Task 2: OAuth module

**Files:**
- Create: `seat-proxy/src/seatproxy/oauth.py`
- Test: `seat-proxy/tests/test_oauth.py`

**Interfaces:**
- Consumes: `SeatTokens`, `providers`, `AuthRejected`.
- Produces: `new_pkce() -> tuple[str, str]` returning `(verifier, challenge)`;
  `authorize_url(provider: str, challenge: str, state: str) -> str`;
  `async def exchange_code(client, provider, code, verifier) -> SeatTokens`;
  `async def start_device_code(client) -> dict`;
  `async def poll_device_code(client, device_code) -> SeatTokens | None` returning `None` while
  authorization is still pending.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_oauth.py
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
    assert "user:inference" in q["scope"][0]

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_oauth.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.oauth'`

- [ ] **Step 3: Write the implementation**

```python
# seat-proxy/src/seatproxy/oauth.py
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_oauth.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/oauth.py seat-proxy/tests/test_oauth.py
git commit -m "feat(seat-proxy): provider OAuth driven by the proxy"
```

---

### Task 3: Rewire enrollment onto OAuth

**Files:**
- Modify: `seat-proxy/src/seatproxy/app.py`
- Modify: `seat-proxy/tests/test_app.py`

**Interfaces:**
- `POST /enroll/{provider}/start` now returns, for Anthropic
  `{enroll_id, kind: "authorize_url", url}`, and for OpenAI
  `{enroll_id, kind: "device_code", user_code, verification_uri, interval}`.
- `POST /enroll/{provider}/complete` takes `{enroll_id, code}` for Anthropic; for OpenAI `code` is
  omitted and the proxy polls once, returning `{status: "pending"}` until authorized.
- On success both mint a handle and return `{status: "complete", handle, models[]}`.

The owner validation, `config_dir_for` containment check, `0700` directory creation and the relay
mounts are all unchanged. Only `start` and the old `poll` are replaced.

- [ ] **Step 1: Write the failing test**

```python
# append to seat-proxy/tests/test_app.py
def test_anthropic_start_returns_an_authorize_url(tmp_path):
    _, app = build(tmp_path)
    body = app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "alice"}).json()
    assert body["kind"] == "authorize_url"
    assert body["url"].startswith("https://claude.com/cai/oauth/authorize?")
    assert body["enroll_id"]
    assert "verifier" not in str(body)        # the verifier must stay server-side

def test_complete_rejects_unknown_enroll_id(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/complete",
                 json={"enroll_id": "nope", "code": "x"})
    assert r.status_code == 404

def test_anthropic_complete_exchanges_and_mints_a_handle(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    store, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    body = app.post("/enroll/anthropic/complete",
                    json={"enroll_id": start["enroll_id"], "code": "THECODE"}).json()
    assert body["status"] == "complete"
    rec = store.get(body["handle"])
    assert rec.owner == "alice" and rec.provider == "anthropic"
    creds = json.loads(
        (tmp_path / "state" / "alice" / "anthropic" / ".credentials.json")
        .read_text(encoding="utf-8"))
    assert creds["claudeAiOauth"]["accessToken"] == "A"

def test_complete_is_single_use(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    payload = {"enroll_id": start["enroll_id"], "code": "THECODE"}
    assert app.post("/enroll/anthropic/complete", json=payload).json()["status"] == "complete"
    assert app.post("/enroll/anthropic/complete", json=payload).status_code == 404

def test_rejected_code_returns_401_not_500(tmp_path):
    def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    r = app.post("/enroll/anthropic/complete",
                 json={"enroll_id": start["enroll_id"], "code": "BAD"})
    assert r.status_code == 401
    assert "detail" not in r.json()

def test_openai_start_returns_a_device_code(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                         "verification_uri_complete": "https://x/y",
                                         "interval": 5})
    _, app = build(tmp_path, handler)
    body = app.post("/enroll/openai/start", headers={"X-Seat-Owner": "alice"}).json()
    assert body["kind"] == "device_code"
    assert body["user_code"] == "ABCD-1234"
    assert "device_code" not in body          # server-side only
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_app.py -v`
Expected: failures on the new tests (`kind` missing, `/complete` 404s as an unknown route).

- [ ] **Step 3: Replace `start` and `poll` in `app.py`**

Keep `_valid_owner`, `_WINDOWS_RESERVED`, `_OWNER_PATTERN`, `config_dir_for`, the `models` and
`revoke` endpoints, and both relay mounts exactly as they are. Replace the `start` and `poll`
handlers with:

```python
    @app.post("/enroll/{provider}/start")
    async def start(provider: str, x_seat_owner: str | None = Header(default=None)):
        if not providers.is_valid(provider):
            return provider_error(providers.ANTHROPIC, 400, "invalid_request_error",
                                  "Unknown provider.")
        if not x_seat_owner:
            return provider_error(provider, 400, "invalid_request_error",
                                  "X-Seat-Owner header is required.")
        if not _valid_owner(x_seat_owner):
            return provider_error(provider, 400, "invalid_request_error",
                                  "X-Seat-Owner is not a valid owner name.")
        cfg = config_dir_for(x_seat_owner, provider)
        cfg.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(cfg, 0o700)
        except OSError:
            pass          # best effort; Windows has no POSIX mode

        enroll_id = secrets.token_urlsafe(16)
        entry = {"owner": x_seat_owner, "provider": provider, "config_dir": str(cfg)}
        if provider == providers.ANTHROPIC:
            verifier, challenge = oauth.new_pkce()
            state = secrets.token_urlsafe(12)
            entry["verifier"] = verifier
            pending[enroll_id] = entry
            # The verifier never leaves the server: the client gets only the URL.
            return {"enroll_id": enroll_id, "kind": "authorize_url",
                    "url": oauth.authorize_url(provider, challenge, state)}

        device = await oauth.start_device_code(client)
        entry["device_code"] = device["device_code"]
        pending[enroll_id] = entry
        return {"enroll_id": enroll_id, "kind": "device_code",
                "user_code": device.get("user_code"),
                "verification_uri": device.get("verification_uri_complete")
                                    or device.get("verification_uri"),
                "interval": device.get("interval", 5)}

    @app.post("/enroll/{provider}/complete")
    async def complete(provider: str, payload: dict):
        entry = pending.get(payload.get("enroll_id", ""))
        if entry is None or entry["provider"] != provider:
            return provider_error(provider, 404, "invalid_request_error",
                                  "Unknown enroll_id.")
        try:
            if provider == providers.ANTHROPIC:
                code = payload.get("code", "")
                if not code:
                    return provider_error(provider, 400, "invalid_request_error",
                                          "A code is required.")
                tokens = await oauth.exchange_code(client, provider, code,
                                                   entry["verifier"])
            else:
                tokens = await oauth.poll_device_code(client, entry["device_code"])
                if tokens is None:
                    return {"status": "pending"}
        except AuthRejected:
            return provider_error(provider, 401, "authentication_error",
                                  "That authorization was rejected. Start again.")
        except Exception:
            return provider_error(provider, 502, "api_error",
                                  "Could not complete authorization.")

        create_tokens(entry["provider"], entry["config_dir"], tokens)
        existing = store.find(entry["owner"], entry["provider"])
        if existing is not None:
            store.delete(existing.handle)
        handle = store.put(entry["owner"], entry["provider"], entry["config_dir"])
        # Single use: the code and verifier are spent.
        pending.pop(payload["enroll_id"], None)
        module = _SEAT_MODULES[entry["provider"]]
        models = await module.fetch_available_models(client, tokens.access_token)
        return {"status": "complete", "handle": handle, "models": models}
```

Extend the imports at the top of `app.py`:

```python
from . import anthropic_seat, oauth, openai_seat, providers
from .credentials import (CredentialsMalformed, CredentialsMissing, create_tokens,
                          read_tokens)
from .refresh import AuthRejected
```

- [ ] **Step 4: Repair the superseded tests**

The old `test_poll_*` tests and any test asserting `start` returns a `command` string are testing
endpoints that no longer exist. Update each to the new contract — do not delete coverage. If a test
cannot be meaningfully translated, say which and why in your report rather than dropping it.

- [ ] **Step 5: Run the suite**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest -v`
Report exact totals; do not predict them.

- [ ] **Step 6: Commit**

```bash
git add seat-proxy/src/seatproxy/app.py seat-proxy/tests/test_app.py
git commit -m "feat(seat-proxy): enroll via proxy-driven OAuth instead of a CLI login"
```

---

### Task 4: Documentation and live smoke

**Files:**
- Modify: `seat-proxy/README.md`

- [ ] **Step 1: Rewrite the enrollment section**

Replace the "run this CLI command" instructions with the OAuth flow: `POST /enroll/anthropic/start`
returns a URL, the user opens it and approves, Anthropic shows them a code, they `POST
/enroll/anthropic/complete` with `{enroll_id, code}`. For OpenAI, `start` returns a user code and
verification URL; the user enters the code there and the client polls `complete` until it stops
returning `{"status": "pending"}`.

State plainly that the provider CLIs are **no longer required on the host**, and that nobody needs
shell access to enrol.

Keep the existing security section, and add one line: the consent screen names **Claude Code**,
because the flow uses Claude Code's public OAuth client — so users approving it see that name
rather than this deployment's.

- [ ] **Step 2: Start the service and smoke the new endpoints**

```bash
cd C:\Developer\cloudflare-os\seat-proxy
SEAT_PROXY_STATE=<scratch>/state SEAT_PROXY_DB=<scratch>/seats.db python main.py
```

Then check `POST /enroll/anthropic/start` with `X-Seat-Owner: admin` returns a `claude.com`
authorize URL, and that `POST /enroll/anthropic/complete` with a bogus `enroll_id` returns a
provider-shaped 404. Do not complete a real authorization — that is the user's to do.

- [ ] **Step 3: Commit**

```bash
git add seat-proxy/README.md
git commit -m "docs(seat-proxy): document OAuth enrollment"
```

---

## Out of scope

The Cloudflare OS fork — the sign-in buttons and their RPC methods — is Plan 2. Completing a real
authorization against a live seat needs the user.
