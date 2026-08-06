# Seat Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone service that lets Cloudflare OS use Claude Max/Pro and ChatGPT/Codex subscription seats, holding OAuth tokens itself and accepting opaque per-user handles in place of API keys.

**Architecture:** A FastAPI service with two surfaces. *Enrollment* runs OAuth device flows and mints a handle per user per provider. *Relay* accepts a handle where the provider expects an API key, swaps it for a live bearer token, and forwards to the real upstream with streaming passed through untouched. Real tokens never leave the service.

**Tech Stack:** Python 3.13, FastAPI, httpx, cryptography (Fernet), SQLite (stdlib `sqlite3`), pytest.

## Global Constraints

- Python 3.13. Service lives in `seat-proxy/` at the repo root, with its own venv and `requirements.txt`. It is a separate process from Cloudflare OS, co-versioned with the fork that needs it.
- **Never log handles or tokens.** Log owner, provider, status, and latency only.
- **All error responses use the upstream provider's error shape.** Anthropic: `{"type":"error","error":{"type":...,"message":...}}`. FastAPI's default `{"detail": ...}` is a bug.
- **Streaming must be unbuffered** — `httpx.stream` into `StreamingResponse`. Never `await response.aread()` on a relay path.
- Refresh locks are **per handle**, never global.
- Upstream non-2xx responses (429, 5xx) pass through with status and headers intact.
- Anthropic relay requires the `anthropic-beta: oauth-2025-04-20` header on every forwarded request.

---

### Task 1: Spike the Anthropic device flow (GATE)

This task is discovery, not TDD. **Every later Anthropic task depends on its output.** Do not start Task 6 until this resolves.

**Files:**
- Create: `seat-proxy/spike/anthropic_device_flow.py` (throwaway, not shipped)
- Create: `seat-proxy/src/seatproxy/anthropic_oauth.py` (the constants this task discovers)

**Interfaces:**
- Consumes: nothing.
- Produces: `ANTHROPIC_CLIENT_ID: str`, `ANTHROPIC_DEVICE_CODE_URL: str`, `ANTHROPIC_TOKEN_URL: str`, `ANTHROPIC_SCOPES: str` in `anthropic_oauth.py`.

- [ ] **Step 1: Write a script that requests a device code**

```python
# seat-proxy/spike/anthropic_device_flow.py
import httpx, time, sys

CLIENT_ID = sys.argv[1]              # candidate client_id under test
DEVICE_CODE_URL = "https://console.anthropic.com/v1/oauth/device/code"
TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

r = httpx.post(DEVICE_CODE_URL, json={"client_id": CLIENT_ID, "scope": "user:inference"})
print(r.status_code, r.text)
r.raise_for_status()
d = r.json()
print("Open:", d["verification_uri_complete"], "code:", d["user_code"])
```

- [ ] **Step 2: Run it and record the outcome**

Run: `python seat-proxy/spike/anthropic_device_flow.py <candidate-client-id>`

Record the exact status and body in a comment at the top of the file, whatever happens.

- [ ] **Step 3: If a device code is issued, poll for tokens**

```python
while True:
    t = httpx.post(TOKEN_URL, json={
        "client_id": CLIENT_ID,
        "device_code": d["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    })
    if t.status_code == 200:
        break
    if t.json().get("error") != "authorization_pending":
        raise SystemExit(f"failed: {t.status_code} {t.text}")
    time.sleep(d.get("interval", 5))
tokens = t.json()
print("got tokens, expires_in:", tokens.get("expires_in"))
```

- [ ] **Step 4: Prove the token actually works for inference**

```python
m = httpx.post("https://api.anthropic.com/v1/messages",
    headers={
        "Authorization": f"Bearer {tokens['access_token']}",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    },
    json={"model": "claude-sonnet-5", "max_tokens": 16,
          "messages": [{"role": "user", "content": "say hi"}]})
print(m.status_code, m.text[:400])
```

Expected on success: HTTP 200 with a `content` array.

- [ ] **Step 5: Apply the decision rule**

- **Inference call returns 200** → write the working constants into
  `seat-proxy/src/seatproxy/anthropic_oauth.py` and continue to Task 2.
- **Any step fails** → STOP. Report the exact failing status and body to the user. The Anthropic
  leg is not viable; Tasks 6 and 7 are cut and the plan continues with OpenAI only (Tasks 2-5, 8-10).

- [ ] **Step 6: Commit the constants (only if the spike succeeded)**

```bash
git add seat-proxy/src/seatproxy/anthropic_oauth.py seat-proxy/spike/anthropic_device_flow.py
git commit -m "feat(seat-proxy): record verified Anthropic device-flow constants"
```

---

### Task 2: Project skeleton and encrypted token store

**Files:**
- Create: `seat-proxy/requirements.txt`, `seat-proxy/src/seatproxy/__init__.py`
- Create: `seat-proxy/src/seatproxy/store.py`
- Test: `seat-proxy/tests/test_store.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `TokenStore(db_path: str, fernet_key: bytes)` with
  `put(owner: str, provider: str, access: str, refresh: str, expires_at: float) -> str` returning a handle,
  `get(handle: str) -> Record | None`,
  `update_tokens(handle: str, access: str, refresh: str, expires_at: float) -> None`,
  `mark_needs_reauth(handle: str) -> None`,
  `delete(handle: str) -> None`.
  `Record` is a dataclass with fields `handle, owner, provider, access_token, refresh_token, expires_at, needs_reauth`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_store.py
import sqlite3
from cryptography.fernet import Fernet
from seatproxy.store import TokenStore

def test_roundtrip_and_tokens_encrypted_at_rest(tmp_path):
    db = str(tmp_path / "s.db")
    store = TokenStore(db, Fernet.generate_key())
    handle = store.put("alice", "anthropic", "ACCESS-SECRET", "REFRESH-SECRET", 1000.0)

    rec = store.get(handle)
    assert rec.owner == "alice"
    assert rec.access_token == "ACCESS-SECRET"
    assert rec.needs_reauth is False

    raw = sqlite3.connect(db).execute("select * from seats").fetchone()
    assert "ACCESS-SECRET" not in str(raw)

def test_handles_are_unique_and_opaque(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    a = store.put("alice", "anthropic", "x", "y", 1.0)
    b = store.put("alice", "anthropic", "x", "y", 1.0)
    assert a != b and len(a) >= 32 and "alice" not in a

def test_get_unknown_handle_returns_none(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    assert store.get("nope") is None

def test_mark_needs_reauth_and_delete(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    h = store.put("bob", "openai", "a", "r", 5.0)
    store.mark_needs_reauth(h)
    assert store.get(h).needs_reauth is True
    store.delete(h)
    assert store.get(h) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.store'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/store.py
import secrets, sqlite3
from contextlib import closing
from dataclasses import dataclass
from cryptography.fernet import Fernet

@dataclass
class Record:
    handle: str
    owner: str
    provider: str
    access_token: str
    refresh_token: str
    expires_at: float
    needs_reauth: bool

class TokenStore:
    def __init__(self, db_path: str, fernet_key: bytes):
        self._db_path = db_path
        self._f = Fernet(fernet_key)
        with self._conn() as c:
            c.execute("""create table if not exists seats (
                handle text primary key, owner text not null, provider text not null,
                access blob not null, refresh blob not null,
                expires_at real not null, needs_reauth integer not null default 0)""")

    def _conn(self):
        # closing() actually closes the handle on exit. A bare `with sqlite3.connect(...)`
        # only commits or rolls back the transaction — it leaves the connection open, which
        # leaks a file handle per call on a long-running service. isolation_level=None means
        # autocommit, so no explicit commit is needed.
        return closing(sqlite3.connect(self._db_path, isolation_level=None))

    def put(self, owner, provider, access, refresh, expires_at) -> str:
        handle = secrets.token_urlsafe(32)
        with self._conn() as c:
            c.execute("insert into seats values (?,?,?,?,?,?,0)",
                      (handle, owner, provider, self._f.encrypt(access.encode()),
                       self._f.encrypt(refresh.encode()), expires_at))
        return handle

    def get(self, handle):
        with self._conn() as c:
            row = c.execute(
                "select handle,owner,provider,access,refresh,expires_at,needs_reauth "
                "from seats where handle=?", (handle,)).fetchone()
        if row is None:
            return None
        return Record(row[0], row[1], row[2], self._f.decrypt(row[3]).decode(),
                      self._f.decrypt(row[4]).decode(), row[5], bool(row[6]))

    def update_tokens(self, handle, access, refresh, expires_at):
        with self._conn() as c:
            c.execute("update seats set access=?,refresh=?,expires_at=?,needs_reauth=0 "
                      "where handle=?", (self._f.encrypt(access.encode()),
                                         self._f.encrypt(refresh.encode()), expires_at, handle))

    def mark_needs_reauth(self, handle):
        with self._conn() as c:
            c.execute("update seats set needs_reauth=1 where handle=?", (handle,))

    def delete(self, handle):
        with self._conn() as c:
            c.execute("delete from seats where handle=?", (handle,))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_store.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/
git commit -m "feat(seat-proxy): encrypted per-handle token store"
```

---

### Task 3: Provider-shaped error responses

Build this before any relay path so error shape is never an afterthought.

**Files:**
- Create: `seat-proxy/src/seatproxy/errors.py`
- Test: `seat-proxy/tests/test_errors.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `provider_error(provider: str, status: int, kind: str, message: str) -> JSONResponse`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_errors.py
import json
from seatproxy.errors import provider_error

def test_anthropic_error_shape():
    r = provider_error("anthropic", 401, "authentication_error", "reconnect your seat")
    body = json.loads(r.body)
    assert r.status_code == 401
    assert body == {"type": "error",
                    "error": {"type": "authentication_error", "message": "reconnect your seat"}}

def test_openai_error_shape():
    r = provider_error("openai", 401, "invalid_request_error", "reconnect your seat")
    body = json.loads(r.body)
    assert r.status_code == 401
    assert body["error"]["message"] == "reconnect your seat"
    assert body["error"]["type"] == "invalid_request_error"
    assert body["error"]["code"] is None
    assert body["error"]["param"] is None
    assert "detail" not in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_errors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.errors'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/errors.py
from fastapi.responses import JSONResponse

def provider_error(provider: str, status: int, kind: str, message: str) -> JSONResponse:
    if provider == "anthropic":
        body = {"type": "error", "error": {"type": kind, "message": message}}
    else:
        body = {"error": {"type": kind, "message": message, "code": None, "param": None}}
    return JSONResponse(status_code=status, content=body)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_errors.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/errors.py seat-proxy/tests/test_errors.py
git commit -m "feat(seat-proxy): provider-native error shapes"
```

---

### Task 4: Token refresh with expiry skew and per-handle locking

**Files:**
- Create: `seat-proxy/src/seatproxy/refresh.py`
- Test: `seat-proxy/tests/test_refresh.py`

**Interfaces:**
- Consumes: `TokenStore`, `Record` from Task 2.
- Produces: `REFRESH_SKEW_SECONDS = 120`;
  `async def resolve_access_token(store: TokenStore, handle: str, now: float, refresher: Callable[[Record], Awaitable[tuple[str, str, float]]]) -> str`.
  Raises `SeatNeedsReauth` (defined here) when refresh fails or the record is flagged.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_refresh.py
import asyncio, pytest
from cryptography.fernet import Fernet
from seatproxy.store import TokenStore
from seatproxy.refresh import resolve_access_token, SeatNeedsReauth

def make_store(tmp_path):
    return TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())

@pytest.mark.asyncio
async def test_returns_existing_token_when_fresh(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "GOOD", "R", 10_000.0)
    async def refresher(rec):
        raise AssertionError("must not refresh a fresh token")
    assert await resolve_access_token(store, h, now=5_000.0, refresher=refresher) == "GOOD"

@pytest.mark.asyncio
async def test_refreshes_inside_skew_window(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 5_060.0)   # 60s out, skew is 120s
    async def refresher(rec):
        return ("NEW", "R2", 9_000.0)
    assert await resolve_access_token(store, h, now=5_000.0, refresher=refresher) == "NEW"
    assert store.get(h).access_token == "NEW"

@pytest.mark.asyncio
async def test_concurrent_calls_refresh_only_once(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 0.0)
    calls = []
    async def refresher(rec):
        calls.append(1)
        await asyncio.sleep(0.05)
        return ("NEW", "R2", 9_000.0)
    results = await asyncio.gather(*[
        resolve_access_token(store, h, now=5_000.0, refresher=refresher) for _ in range(5)])
    assert results == ["NEW"] * 5
    assert len(calls) == 1

@pytest.mark.asyncio
async def test_failed_refresh_flags_needs_reauth(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 0.0)
    async def refresher(rec):
        raise RuntimeError("refresh token revoked")
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert store.get(h).needs_reauth is True

@pytest.mark.asyncio
async def test_already_flagged_record_raises_without_refreshing(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 10_000.0)
    store.mark_needs_reauth(h)
    async def refresher(rec):
        raise AssertionError("must not refresh a flagged seat")
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_refresh.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.refresh'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/refresh.py
import asyncio
from collections import defaultdict

REFRESH_SKEW_SECONDS = 120

class SeatNeedsReauth(Exception):
    pass

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

async def resolve_access_token(store, handle, now, refresher) -> str:
    rec = store.get(handle)
    if rec is None or rec.needs_reauth:
        raise SeatNeedsReauth(handle)
    if now < rec.expires_at - REFRESH_SKEW_SECONDS:
        return rec.access_token

    async with _locks[handle]:
        rec = store.get(handle)
        if rec is None or rec.needs_reauth:
            raise SeatNeedsReauth(handle)
        # Another waiter may have refreshed while we queued.
        if now < rec.expires_at - REFRESH_SKEW_SECONDS:
            return rec.access_token
        try:
            access, refresh, expires_at = await refresher(rec)
        except Exception as exc:
            store.mark_needs_reauth(handle)
            raise SeatNeedsReauth(handle) from exc
        store.update_tokens(handle, access, refresh, expires_at)
        return access
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_refresh.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/refresh.py seat-proxy/tests/test_refresh.py
git commit -m "feat(seat-proxy): refresh with expiry skew and per-handle locking"
```

---

### Task 5: Relay core — header rewriting and streaming pass-through

The contract test here is the one that protects the whole design.

**Files:**
- Create: `seat-proxy/src/seatproxy/relay.py`
- Test: `seat-proxy/tests/test_relay.py`

**Interfaces:**
- Consumes: `resolve_access_token`, `SeatNeedsReauth` (Task 4); `provider_error` (Task 3).
- Produces: `def outbound_headers(provider: str, incoming: dict[str, str], access_token: str) -> dict[str, str]`
  and `async def relay(request, provider, upstream_base, store, client, now, refresher=None)`
  returning a `StreamingResponse`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_relay.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_relay.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.relay'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/relay.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_relay.py -v`
Expected: 4 passed

- [ ] **Step 5: Write the failing streaming test**

```python
# append to seat-proxy/tests/test_relay.py
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

@pytest.mark.asyncio
async def test_streams_incrementally_without_buffering(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    h = store.put("alice", "anthropic", "ACCESS", "R", 10_000.0)
    chunks_out = [b"data: a\n\n", b"data: b\n\n", b"data: c\n\n"]

    async def handler(request):
        assert request.headers["authorization"] == "Bearer ACCESS"
        async def gen():
            for c in chunks_out:
                yield c
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              stream=httpx.AsyncByteStream(gen()))

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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_relay.py -v`
Expected: FAIL with `ImportError: cannot import name 'relay'`

- [ ] **Step 7: Implement the relay**

```python
# append to seat-proxy/src/seatproxy/relay.py
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_relay.py -v`
Expected: 7 passed

- [ ] **Step 9: Commit**

```bash
git add seat-proxy/src/seatproxy/relay.py seat-proxy/tests/test_relay.py
git commit -m "feat(seat-proxy): relay with header rewriting and streaming pass-through"
```

---

### Task 6: Anthropic refresher

**Blocked by Task 1.** Skip if the spike failed.

**Files:**
- Modify: `seat-proxy/src/seatproxy/anthropic_oauth.py`
- Test: `seat-proxy/tests/test_anthropic_oauth.py`

**Interfaces:**
- Consumes: constants from Task 1; `Record` from Task 2.
- Produces: `async def start_device_flow(client) -> dict`, `async def poll_device_flow(client, device_code) -> dict`,
  `async def refresh_anthropic(client, rec) -> tuple[str, str, float]`,
  `async def fetch_available_models(client, access_token) -> list[str]`.
  Task 8's `app.py` calls `fetch_available_models` on **both** oauth modules, so this module must
  expose it under the same name as `openai_oauth`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_anthropic_oauth.py
import httpx, pytest, time
from seatproxy.store import Record
from seatproxy.anthropic_oauth import refresh_anthropic, ANTHROPIC_CLIENT_ID

@pytest.mark.asyncio
async def test_refresh_returns_new_tokens_and_absolute_expiry():
    async def handler(request):
        body = dict(x.split("=") for x in request.content.decode().split("&")) \
            if request.headers.get("content-type", "").startswith("application/x-www-form") \
            else __import__("json").loads(request.content)
        assert body["grant_type"] == "refresh_token"
        assert body["client_id"] == ANTHROPIC_CLIENT_ID
        return httpx.Response(200, json={"access_token": "NEW", "refresh_token": "NEWR",
                                         "expires_in": 3600})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rec = Record("h", "alice", "anthropic", "OLD", "OLDR", 0.0, False)
    before = time.time()
    access, refresh, expires_at = await refresh_anthropic(client, rec)
    assert (access, refresh) == ("NEW", "NEWR")
    assert before + 3500 < expires_at <= time.time() + 3600

@pytest.mark.asyncio
async def test_refresh_raises_on_revoked_token():
    async def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rec = Record("h", "alice", "anthropic", "OLD", "OLDR", 0.0, False)
    with pytest.raises(Exception):
        await refresh_anthropic(client, rec)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_anthropic_oauth.py -v`
Expected: FAIL with `ImportError: cannot import name 'refresh_anthropic'`

- [ ] **Step 3: Write minimal implementation**

```python
# append to seat-proxy/src/seatproxy/anthropic_oauth.py
import time, httpx

async def start_device_flow(client: httpx.AsyncClient) -> dict:
    r = await client.post(ANTHROPIC_DEVICE_CODE_URL,
                          json={"client_id": ANTHROPIC_CLIENT_ID, "scope": ANTHROPIC_SCOPES})
    r.raise_for_status()
    return r.json()

async def poll_device_flow(client: httpx.AsyncClient, device_code: str) -> dict:
    r = await client.post(ANTHROPIC_TOKEN_URL, json={
        "client_id": ANTHROPIC_CLIENT_ID, "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
    return {"status": r.status_code, "body": r.json()}

async def refresh_anthropic(client: httpx.AsyncClient, rec) -> tuple[str, str, float]:
    r = await client.post(ANTHROPIC_TOKEN_URL, json={
        "client_id": ANTHROPIC_CLIENT_ID, "grant_type": "refresh_token",
        "refresh_token": rec.refresh_token})
    r.raise_for_status()
    d = r.json()
    return d["access_token"], d.get("refresh_token", rec.refresh_token), \
        time.time() + float(d["expires_in"])

# The catalog is static for seats: Anthropic exposes no per-seat model list endpoint, so return
# the models the spike in Task 1 confirmed the seat can call. Same name as openai_oauth's so
# app.py can treat both modules identically.
ANTHROPIC_SEAT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]

async def fetch_available_models(client: httpx.AsyncClient, access_token: str) -> list[str]:
    return list(ANTHROPIC_SEAT_MODELS)
```

- [ ] **Step 4: Add a test for the model list**

```python
# append to seat-proxy/tests/test_anthropic_oauth.py
from seatproxy.anthropic_oauth import fetch_available_models

@pytest.mark.asyncio
async def test_fetch_available_models_returns_seat_catalog():
    models = await fetch_available_models(None, "ACCESS")
    assert "claude-sonnet-5" in models
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_anthropic_oauth.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add seat-proxy/src/seatproxy/anthropic_oauth.py seat-proxy/tests/test_anthropic_oauth.py
git commit -m "feat(seat-proxy): Anthropic device flow and refresh"
```

---

### Task 7: OpenAI/Codex refresher, ported from Odysseus

**Files:**
- Create: `seat-proxy/src/seatproxy/openai_oauth.py`
- Test: `seat-proxy/tests/test_openai_oauth.py`

**Interfaces:**
- Consumes: `Record` from Task 2.
- Produces: `CHATGPT_CLIENT_ID`, `CHATGPT_TOKEN_URL`, `CHATGPT_BASE_URL`;
  `async def refresh_openai(client, rec) -> tuple[str, str, float]`;
  `async def fetch_available_models(client, access_token) -> list[str]`.

Port from `C:\Developer\odysseus\src\chatgpt_subscription.py`. Reuse its constants verbatim:
`CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`, `CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"`, `DEFAULT_CHATGPT_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex"`. Convert the `httpx` calls from sync to async; drop the SQLAlchemy `ProviderAuthSession` handling, which `TokenStore` replaces.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_openai_oauth.py
import httpx, pytest, time
from seatproxy.store import Record
from seatproxy.openai_oauth import refresh_openai, fetch_available_models, CHATGPT_CLIENT_ID

def test_client_id_matches_odysseus():
    assert CHATGPT_CLIENT_ID == "app_EMoamEEZ73f0CkXaXp7hrann"

@pytest.mark.asyncio
async def test_refresh_posts_form_encoded_and_returns_absolute_expiry():
    async def handler(request):
        assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
        assert b"grant_type=refresh_token" in request.content
        return httpx.Response(200, json={"access_token": "NEW", "refresh_token": "NEWR",
                                         "expires_in": 1800})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rec = Record("h", "bob", "openai", "OLD", "OLDR", 0.0, False)
    before = time.time()
    access, refresh, expires_at = await refresh_openai(client, rec)
    assert (access, refresh) == ("NEW", "NEWR")
    assert before + 1700 < expires_at <= time.time() + 1800

@pytest.mark.asyncio
async def test_fetch_available_models_sends_browser_headers():
    async def handler(request):
        assert request.headers["origin"] == "https://chatgpt.com"
        assert request.headers["authorization"] == "Bearer ACCESS"
        return httpx.Response(200, json={"models": [{"slug": "gpt-5-codex"}]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_available_models(client, "ACCESS") == ["gpt-5-codex"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_openai_oauth.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.openai_oauth'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/openai_oauth.py
import time, httpx

CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token"
CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"

def chatgpt_headers(access_token: str | None) -> dict:
    h = {"Accept": "application/json, text/event-stream",
         "Origin": "https://chatgpt.com",
         "Referer": "https://chatgpt.com/codex",
         "User-Agent": "Odysseus ChatGPT Subscription"}
    if access_token:
        h["Authorization"] = f"Bearer {access_token}"
    return h

async def refresh_openai(client: httpx.AsyncClient, rec) -> tuple[str, str, float]:
    r = await client.post(CHATGPT_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"client_id": CHATGPT_CLIENT_ID, "grant_type": "refresh_token",
              "refresh_token": rec.refresh_token})
    r.raise_for_status()
    d = r.json()
    return d["access_token"], d.get("refresh_token", rec.refresh_token), \
        time.time() + float(d["expires_in"])

async def fetch_available_models(client: httpx.AsyncClient, access_token: str) -> list[str]:
    r = await client.get(f"{CHATGPT_BASE_URL}/models", headers=chatgpt_headers(access_token))
    r.raise_for_status()
    return [m["slug"] for m in r.json().get("models", [])]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_openai_oauth.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/openai_oauth.py seat-proxy/tests/test_openai_oauth.py
git commit -m "feat(seat-proxy): OpenAI/Codex refresh ported from Odysseus"
```

---

### Task 8: Enrollment endpoints and app wiring

**Files:**
- Create: `seat-proxy/src/seatproxy/app.py`, `seat-proxy/src/seatproxy/config.py`
- Test: `seat-proxy/tests/test_app.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `create_app(store, client) -> FastAPI` exposing
  `POST /enroll/{provider}/start`, `POST /enroll/{provider}/poll`,
  `GET /enroll/{provider}/models`, `DELETE /enroll/{handle}`,
  and the relay mounts `/anthropic/{path:path}`, `/openai/{path:path}`.
  Enrollment requires header `X-Seat-Owner`, the authenticated Cloudflare OS username.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_app.py
import httpx, pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from seatproxy.store import TokenStore
from seatproxy.app import create_app

def build(tmp_path, handler):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return store, TestClient(create_app(store, client))

def test_enroll_start_requires_owner_header(tmp_path):
    _, app = build(tmp_path, lambda r: httpx.Response(200, json={}))
    assert app.post("/enroll/anthropic/start").status_code == 400

def test_enroll_start_returns_device_code(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                         "verification_uri_complete": "https://x/y",
                                         "interval": 5})
    _, app = build(tmp_path, handler)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": "alice"})
    assert r.status_code == 200
    assert r.json()["user_code"] == "ABCD-1234"
    assert "device_code" not in r.json()      # never leaks to the browser

def test_delete_handle_revokes(tmp_path):
    store, app = build(tmp_path, lambda r: httpx.Response(200, json={}))
    h = store.put("alice", "anthropic", "a", "r", 9e9)
    assert app.delete(f"/enroll/{h}", headers={"X-Seat-Owner": "alice"}).status_code == 204
    assert store.get(h) is None

def test_delete_rejects_other_owners_handle(tmp_path):
    store, app = build(tmp_path, lambda r: httpx.Response(200, json={}))
    h = store.put("alice", "anthropic", "a", "r", 9e9)
    assert app.delete(f"/enroll/{h}", headers={"X-Seat-Owner": "mallory"}).status_code == 404
    assert store.get(h) is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd seat-proxy && python -m pytest tests/test_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.app'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/app.py
import time, secrets
from fastapi import FastAPI, Header, Request, Response
from .errors import provider_error
from .relay import relay
from . import openai_oauth

_PENDING: dict[str, dict] = {}

def create_app(store, client) -> FastAPI:
    app = FastAPI()

    def oauth_module(provider):
        if provider == "openai":
            return openai_oauth
        from . import anthropic_oauth
        return anthropic_oauth

    @app.post("/enroll/{provider}/start")
    async def start(provider: str, x_seat_owner: str | None = Header(default=None)):
        if not x_seat_owner:
            return provider_error(provider, 400, "invalid_request_error",
                                  "X-Seat-Owner header is required.")
        d = await oauth_module(provider).start_device_flow(client)
        poll_id = secrets.token_urlsafe(16)
        _PENDING[poll_id] = {"provider": provider, "owner": x_seat_owner,
                             "device_code": d["device_code"]}
        return {"poll_id": poll_id, "user_code": d["user_code"],
                "verification_uri": d.get("verification_uri_complete")
                                    or d.get("verification_uri"),
                "interval": d.get("interval", 5)}

    @app.post("/enroll/{provider}/poll")
    async def poll(provider: str, payload: dict):
        pending = _PENDING.get(payload.get("poll_id", ""))
        if pending is None:
            return provider_error(provider, 404, "invalid_request_error", "Unknown poll_id.")
        mod = oauth_module(provider)
        result = await mod.poll_device_flow(client, pending["device_code"])
        if result["status"] != 200:
            return {"status": "pending"}
        body = result["body"]
        handle = store.put(pending["owner"], provider, body["access_token"],
                           body["refresh_token"], time.time() + float(body["expires_in"]))
        _PENDING.pop(payload["poll_id"], None)
        models = await mod.fetch_available_models(client, body["access_token"])
        return {"status": "complete", "handle": handle, "models": models}

    @app.get("/enroll/{provider}/models")
    async def models(provider: str, handle: str):
        rec = store.get(handle)
        if rec is None:
            return provider_error(provider, 404, "invalid_request_error", "Unknown handle.")
        return {"models": await oauth_module(provider)
                .fetch_available_models(client, rec.access_token)}

    @app.delete("/enroll/{handle}", status_code=204)
    async def revoke(handle: str, response: Response,
                     x_seat_owner: str | None = Header(default=None)):
        rec = store.get(handle)
        if rec is None or rec.owner != x_seat_owner:
            return provider_error("anthropic", 404, "invalid_request_error", "Unknown handle.")
        store.delete(handle)
        return Response(status_code=204)

    @app.api_route("/anthropic/{path:path}", methods=["POST", "GET"])
    async def anthropic_relay(path: str, request: Request):
        from .anthropic_oauth import refresh_anthropic
        return await relay(request, "anthropic", "https://api.anthropic.com",
                           store, client, time.time(), refresher=
                           lambda rec: refresh_anthropic(client, rec))

    @app.api_route("/openai/{path:path}", methods=["POST", "GET"])
    async def openai_relay(path: str, request: Request):
        return await relay(request, "openai", openai_oauth.CHATGPT_BASE_URL,
                           store, client, time.time(), refresher=
                           lambda rec: openai_oauth.refresh_openai(client, rec))

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd seat-proxy && python -m pytest tests/test_app.py -v`
Expected: 4 passed

- [ ] **Step 5: Run the whole suite**

Run: `cd seat-proxy && python -m pytest -v`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add seat-proxy/src/seatproxy/app.py seat-proxy/tests/test_app.py
git commit -m "feat(seat-proxy): enrollment endpoints and relay mounts"
```

---

### Task 9: Runnable service and end-to-end verification

**Files:**
- Create: `seat-proxy/main.py`, `seat-proxy/README.md`, `seat-proxy/.gitignore`
- Modify: `seat-proxy/requirements.txt`

**Interfaces:**
- Consumes: `create_app` from Task 8.
- Produces: a service on `http://localhost:8890` and documented setup.

- [ ] **Step 1: Write the entrypoint**

```python
# seat-proxy/main.py
import os, httpx, uvicorn
from cryptography.fernet import Fernet
from seatproxy.store import TokenStore
from seatproxy.app import create_app

key = os.environ.get("SEAT_PROXY_KEY")
if not key:
    raise SystemExit("SEAT_PROXY_KEY is required. Generate: "
                     "python -c \"from cryptography.fernet import Fernet;"
                     "print(Fernet.generate_key().decode())\"")

app = create_app(TokenStore(os.environ.get("SEAT_PROXY_DB", "seats.db"), key.encode()),
                 httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SEAT_PROXY_PORT", "8890")))
```

Note the 600s read timeout: long completions must not be cut off mid-stream.

- [ ] **Step 2: Write `.gitignore` and `requirements.txt`**

```
# seat-proxy/.gitignore
seats.db
.venv/
__pycache__/
```

```
# seat-proxy/requirements.txt
fastapi
uvicorn
httpx
cryptography
pytest
pytest-asyncio
```

- [ ] **Step 3: Start the service**

Run:
```bash
cd seat-proxy
export SEAT_PROXY_KEY=$(python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())")
python main.py
```
Expected: `Uvicorn running on http://127.0.0.1:8890`

- [ ] **Step 4: Enroll a seat by hand**

```bash
curl -s -X POST localhost:8890/enroll/anthropic/start -H "X-Seat-Owner: admin"
# open the verification_uri, enter the user_code, then:
curl -s -X POST localhost:8890/enroll/anthropic/poll -H "content-type: application/json" \
  -d '{"poll_id":"<from start>"}'
```
Expected: `{"status":"complete","handle":"...","models":[...]}`

- [ ] **Step 5: Wire it into Cloudflare OS with no fork changes**

In the running OS instance, AI Providers → Add model → Anthropic → **Advanced Settings → API URL** = `http://localhost:8890/anthropic`, API token = the handle from Step 4.

Send a chat message. Expected: a streaming reply. **This is the proof the whole design works** — and confirms the proxy is independently useful before any fork change exists.

- [ ] **Step 6: Verify no secrets are logged**

Run: `grep -iE "sk-ant|Bearer |<your handle>" seat-proxy/*.log 2>/dev/null; echo "exit=$?"`
Expected: no matches.

- [ ] **Step 7: Write the README**

Document: generating `SEAT_PROXY_KEY`, the env vars (`SEAT_PROXY_KEY`, `SEAT_PROXY_DB`, `SEAT_PROXY_PORT`), the manual enrollment flow from Steps 3-4, and the Advanced Settings wiring from Step 5.

- [ ] **Step 8: Commit**

```bash
git add seat-proxy/main.py seat-proxy/README.md seat-proxy/.gitignore seat-proxy/requirements.txt
git commit -m "feat(seat-proxy): runnable service with setup docs"
```

---

## Out of scope for this plan

The Cloudflare OS fork — `seat-types.ts`, `seat-auth.ts`, `SeatSignInButtons.tsx`, and the five
touchpoints — is Plan 2. It replaces Task 9 Step 5's manual wiring with in-product sign-in buttons.
Everything in this plan ships and is usable without it.
