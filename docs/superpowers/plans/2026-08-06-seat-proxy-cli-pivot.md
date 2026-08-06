# Seat Proxy — CLI Piggyback Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the seat proxy by sourcing each user's OAuth tokens from their own provider-CLI credentials directory instead of running any OAuth flow of our own.

**Architecture:** Each user gets a private directory that the provider CLI logs into (`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex). The proxy maps an opaque handle to `{owner, provider, config_dir}`, reads that directory's credentials file on demand, refreshes when near expiry, and mirrors rotated tokens back so the user's CLI stays in sync. The relay built previously is unchanged.

**Tech Stack:** Python 3.13, FastAPI, httpx, SQLite (stdlib), pytest.

**Supersedes:** Tasks 1, 2, 4, and 6-9 of `2026-08-06-seat-proxy.md`. Tasks 3 (`errors.py`) and 5 (`relay.py`) from that plan are shipped and stay as they are.

## Global Constraints

- Python 3.13. Work only inside `C:\Developer\cloudflare-os\seat-proxy\`. `pytest.ini` already sets `pythonpath = src` and `asyncio_mode = auto`. `.gitignore` already covers `__pycache__/` — never commit `.pyc`.
- **Never log handles or tokens.** Log owner, provider, status, latency only.
- **Any struct carrying tokens MUST use `@dataclass(repr=False)` with a masking `__repr__`.** A plain dataclass prints tokens into any locals-capturing traceback (Starlette `debug=True`, Sentry, `pytest --showlocals`). This was applied to `SeatNeedsReauth` previously and lost crossing a module boundary — do not lose it again.
- **Exceptions carry no tokens, handles, or filesystem paths** in their payload.
- **Distinguish auth failure from transport failure.** Only a genuine auth rejection may set `needs_reauth`; a transient read or network error must not brick a seat until manual re-enrollment.
- **The CLI credentials file is authoritative.** Never keep a second durable copy. Write rotations back **atomically** — a torn credentials file breaks the user's CLI.
- **Provider strings come from the shared constant in `providers.py`.** No bare `== "anthropic"` comparisons in new code.
- Handles stay bound to their provider; the relay's provider check must keep working.

---

### Task 1: Shared provider constants

**Files:**
- Create: `seat-proxy/src/seatproxy/providers.py`
- Test: `seat-proxy/tests/test_providers.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `ANTHROPIC = "anthropic"`, `OPENAI = "openai"`, `PROVIDERS = (ANTHROPIC, OPENAI)`,
  `is_valid(provider: str) -> bool`, `CREDENTIALS_FILE: dict[str, str]`,
  `CONFIG_DIR_ENV: dict[str, str]`, `LOGIN_COMMAND: dict[str, str]`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_providers.py
from seatproxy import providers

def test_known_providers():
    assert providers.PROVIDERS == ("anthropic", "openai")
    assert providers.is_valid("anthropic") and providers.is_valid("openai")

def test_unknown_provider_is_rejected():
    assert not providers.is_valid("anthropc")
    assert not providers.is_valid("")

def test_per_provider_tables_cover_every_provider():
    for p in providers.PROVIDERS:
        assert p in providers.CREDENTIALS_FILE
        assert p in providers.CONFIG_DIR_ENV
        assert p in providers.LOGIN_COMMAND

def test_table_values():
    assert providers.CREDENTIALS_FILE["anthropic"] == ".credentials.json"
    assert providers.CREDENTIALS_FILE["openai"] == "auth.json"
    assert providers.CONFIG_DIR_ENV["anthropic"] == "CLAUDE_CONFIG_DIR"
    assert providers.CONFIG_DIR_ENV["openai"] == "CODEX_HOME"
    assert providers.LOGIN_COMMAND["anthropic"] == "claude login"
    assert providers.LOGIN_COMMAND["openai"] == "codex login"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_providers.py -v`
Expected: FAIL with `ImportError: cannot import name 'providers'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/providers.py
"""Single source of truth for provider identifiers and their per-provider tables.

Previously each module compared bare strings with `else` meaning OpenAI, so a
typo'd provider silently got ChatGPT headers and OpenAI error shapes with no
failure signal.
"""

ANTHROPIC = "anthropic"
OPENAI = "openai"
PROVIDERS = (ANTHROPIC, OPENAI)

def is_valid(provider: str) -> bool:
    return provider in PROVIDERS

# Filename the provider's CLI writes inside its config directory.
CREDENTIALS_FILE = {ANTHROPIC: ".credentials.json", OPENAI: "auth.json"}

# Env var that points the CLI at a specific config directory.
CONFIG_DIR_ENV = {ANTHROPIC: "CLAUDE_CONFIG_DIR", OPENAI: "CODEX_HOME"}

# Command the user runs to authenticate that directory.
LOGIN_COMMAND = {ANTHROPIC: "claude login", OPENAI: "codex login"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_providers.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/providers.py seat-proxy/tests/test_providers.py
git commit -m "feat(seat-proxy): shared provider constants and per-provider tables"
```

---

### Task 2: CLI credentials reader and atomic write-back

**Files:**
- Create: `seat-proxy/src/seatproxy/credentials.py`
- Test: `seat-proxy/tests/test_credentials.py`

**Interfaces:**
- Consumes: `providers` (Task 1).
- Produces: `SeatTokens` (masking dataclass with `access_token`, `refresh_token`, `expires_at`
  as epoch **seconds**), `CredentialsMissing`, `CredentialsMalformed`,
  `credentials_path(provider, config_dir) -> Path`,
  `read_tokens(provider, config_dir) -> SeatTokens`,
  `write_tokens(provider, config_dir, tokens) -> None`.

Claude stores `{"claudeAiOauth": {"accessToken", "refreshToken", "expiresAt"}}` with `expiresAt`
in **milliseconds**. Codex stores `{"tokens": {"access_token", "refresh_token"}}` with legacy
fallbacks at the top level. Both shapes are observed from
`OpenWhisperer/src-tauri/src/commands/sdk_cmds.rs:634-660, 805-816`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_credentials.py
import json, pytest
from seatproxy.credentials import (
    SeatTokens, CredentialsMissing, CredentialsMalformed,
    read_tokens, write_tokens, credentials_path)

def write_claude(dirpath, access="A", refresh="R", expires_ms=9_000_000, extra=None):
    doc = {"claudeAiOauth": {"accessToken": access, "refreshToken": refresh,
                             "expiresAt": expires_ms}}
    if extra:
        doc.update(extra)
    (dirpath / ".credentials.json").write_text(json.dumps(doc), encoding="utf-8")

def test_reads_claude_and_converts_ms_to_seconds(tmp_path):
    write_claude(tmp_path, expires_ms=9_000_000)
    t = read_tokens("anthropic", str(tmp_path))
    assert (t.access_token, t.refresh_token) == ("A", "R")
    assert t.expires_at == 9000.0

def test_reads_codex_nested_tokens(tmp_path):
    (tmp_path / "auth.json").write_text(json.dumps(
        {"tokens": {"access_token": "A", "refresh_token": "R"}, "expires_at": 1234.0}),
        encoding="utf-8")
    t = read_tokens("openai", str(tmp_path))
    assert (t.access_token, t.refresh_token, t.expires_at) == ("A", "R", 1234.0)

def test_missing_file_raises_credentials_missing(tmp_path):
    with pytest.raises(CredentialsMissing):
        read_tokens("anthropic", str(tmp_path))

def test_unparseable_file_raises_malformed(tmp_path):
    (tmp_path / ".credentials.json").write_text("not json", encoding="utf-8")
    with pytest.raises(CredentialsMalformed):
        read_tokens("anthropic", str(tmp_path))

def test_missing_fields_raise_malformed(tmp_path):
    (tmp_path / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"accessToken": "A"}}), encoding="utf-8")
    with pytest.raises(CredentialsMalformed):
        read_tokens("anthropic", str(tmp_path))

def test_repr_redacts_tokens():
    t = SeatTokens("SECRET-ACCESS", "SECRET-REFRESH", 1.0)
    text = repr(t)
    assert "SECRET-ACCESS" not in text and "SECRET-REFRESH" not in text
    assert "redacted" in text

def test_exceptions_carry_no_path_or_token(tmp_path):
    with pytest.raises(CredentialsMissing) as exc:
        read_tokens("anthropic", str(tmp_path))
    assert str(tmp_path) not in str(exc.value)

def test_write_back_preserves_unrelated_fields_and_rewrites_ms(tmp_path):
    write_claude(tmp_path, extra={"subscriptionType": "max", "scopes": ["a"]})
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    doc = json.loads((tmp_path / ".credentials.json").read_text(encoding="utf-8"))
    assert doc["claudeAiOauth"]["accessToken"] == "NEW"
    assert doc["claudeAiOauth"]["expiresAt"] == 5_000_000
    assert doc["subscriptionType"] == "max"
    assert doc["scopes"] == ["a"]

def test_write_is_atomic_and_leaves_no_temp_file(tmp_path):
    write_claude(tmp_path)
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    assert [p.name for p in tmp_path.iterdir()] == [".credentials.json"]

def test_credentials_path_uses_provider_filename(tmp_path):
    assert credentials_path("anthropic", str(tmp_path)).name == ".credentials.json"
    assert credentials_path("openai", str(tmp_path)).name == "auth.json"

@pytest.mark.skipif(os.name == "nt",
                    reason="POSIX file modes are not enforced on Windows")
def test_written_credentials_are_owner_only(tmp_path):
    # os.replace makes the destination inherit the temp file's mode, so a
    # default-mode temp would downgrade the user's credentials to world-readable.
    write_claude(tmp_path)
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    assert (tmp_path / ".credentials.json").stat().st_mode & 0o777 == 0o600
```

Add `import os` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_credentials.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.credentials'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/credentials.py
"""Read and write the provider CLIs' own credentials files.

The CLI file is authoritative: it is what the user's CLI reads and rotates, so
the proxy reads on demand and mirrors rotations back rather than keeping its own
durable copy, which would drift.
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path

from . import providers

class CredentialsMissing(Exception):
    """No credentials file yet — the user has not finished the CLI login."""

class CredentialsMalformed(Exception):
    """The file exists but does not have the shape we expect (e.g. CLI changed)."""

class CredentialsUnreadable(Exception):
    """The file exists but could not be read right now (permissions, locking, I/O).

    Distinct from CredentialsMalformed: this is transient and must not be
    reported to the user as a dead seat.
    """

@dataclass(repr=False)
class SeatTokens:
    access_token: str
    refresh_token: str
    expires_at: float          # epoch SECONDS

    def __repr__(self) -> str:
        # Never let tokens reach a traceback, logger, or error reporter.
        return ("SeatTokens(access_token=<redacted>, refresh_token=<redacted>, "
                f"expires_at={self.expires_at})")

def credentials_path(provider: str, config_dir: str) -> Path:
    return Path(config_dir) / providers.CREDENTIALS_FILE[provider]

def _load(provider: str, config_dir: str) -> dict:
    path = credentials_path(provider, config_dir)
    # `from None` throughout: FileNotFoundError and OSError embed the path in their
    # message, and a chained cause still reaches a rendered traceback. The global
    # constraint is that exceptions carry no filesystem paths.
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise CredentialsMissing(provider) from None
    except OSError:
        # FileNotFoundError is caught above; anything else here is transient.
        raise CredentialsUnreadable(provider) from None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        raise CredentialsMalformed(provider) from None
    if not isinstance(parsed, dict):
        raise CredentialsMalformed(provider)
    return parsed

def read_tokens(provider: str, config_dir: str) -> SeatTokens:
    raw = _load(provider, config_dir)
    if provider == providers.ANTHROPIC:
        node = raw.get("claudeAiOauth") or {}
        access = node.get("accessToken")
        refresh = node.get("refreshToken")
        expires_ms = node.get("expiresAt")
        expires = float(expires_ms) / 1000.0 if expires_ms is not None else 0.0
    else:
        node = raw.get("tokens") or {}
        access = (node.get("access_token") or raw.get("access_token")
                  or raw.get("accessToken") or raw.get("token"))
        refresh = node.get("refresh_token") or raw.get("refresh_token")
        expires = float(raw.get("expires_at") or node.get("expires_at") or 0.0)
    if not access or not refresh:
        raise CredentialsMalformed(provider)
    return SeatTokens(access, refresh, expires)

def write_tokens(provider: str, config_dir: str, tokens: SeatTokens) -> None:
    # The CLI's file is authoritative, so refuse to fabricate one. A missing or
    # unparseable file means the config_dir is wrong or the login never completed;
    # silently creating a fresh file there would mask that, and leave the user's
    # real credentials un-rotated while we believe the write succeeded.
    raw = _load(provider, config_dir)
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

    # Atomic replace: a torn credentials file would break the user's own CLI.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_credentials.py -v`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/credentials.py seat-proxy/tests/test_credentials.py
git commit -m "feat(seat-proxy): read and atomically write provider CLI credentials"
```

---

### Task 3: Reshape the store into a handle map

`store.py` currently encrypts and stores tokens. Under the pivot the CLI file owns them, so the
store becomes routing metadata only. Dropping the token columns also drops the Fernet key.

**Files:**
- Rewrite: `seat-proxy/src/seatproxy/store.py`
- Rewrite: `seat-proxy/tests/test_store.py`
- Modify: `seat-proxy/tests/test_relay.py` (construction calls only)

**Interfaces:**
- Consumes: nothing.
- Produces: `SeatStore(db_path: str)` with
  `put(owner: str, provider: str, config_dir: str) -> str` returning a handle,
  `get(handle: str) -> Record | None`,
  `find(owner: str, provider: str) -> Record | None`,
  `mark_needs_reauth(handle: str) -> None`,
  `clear_needs_reauth(handle: str) -> None`,
  `delete(handle: str) -> None`.
  `Record` is a dataclass with `handle, owner, provider, config_dir, needs_reauth`.

`relay.py` must NOT be modified: it only calls `store.get(handle)` and reads `rec.provider`, both
of which survive. Only the store's construction in `test_relay.py` changes.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_store.py  (replace the file entirely)
from seatproxy.store import SeatStore

def test_put_and_get_roundtrip(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/seats/alice/anthropic")
    rec = store.get(h)
    assert rec.owner == "alice"
    assert rec.provider == "anthropic"
    assert rec.config_dir == "/seats/alice/anthropic"
    assert rec.needs_reauth is False

def test_no_token_columns_exist(tmp_path):
    # The CLI credentials file is authoritative; the store must never hold tokens.
    import sqlite3
    db = str(tmp_path / "s.db")
    SeatStore(db).put("alice", "anthropic", "/d")
    cols = {r[1] for r in sqlite3.connect(db).execute("pragma table_info(seats)")}
    assert not cols & {"access", "refresh", "access_token", "refresh_token"}

def test_handles_are_unique_and_opaque(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    a = store.put("alice", "anthropic", "/d")
    b = store.put("alice", "anthropic", "/d")
    assert a != b and len(a) >= 32 and "alice" not in a

def test_get_unknown_handle_returns_none(tmp_path):
    assert SeatStore(str(tmp_path / "s.db")).get("nope") is None

def test_find_by_owner_and_provider(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    assert store.find("alice", "anthropic").handle == h
    assert store.find("alice", "openai") is None
    assert store.find("bob", "anthropic") is None

def test_needs_reauth_can_be_set_and_cleared(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    store.mark_needs_reauth(h)
    assert store.get(h).needs_reauth is True
    store.clear_needs_reauth(h)
    assert store.get(h).needs_reauth is False

def test_delete_removes_the_mapping(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    store.delete(h)
    assert store.get(h) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_store.py -v`
Expected: FAIL with `ImportError: cannot import name 'SeatStore'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/store.py  (replace the file entirely)
"""Handle -> seat routing map.

Holds no tokens: the provider CLI's credentials file inside `config_dir` is
authoritative. `config_dir` is also the seam that lets this later split into
one worker process per user without changing callers.
"""

import secrets
import sqlite3
from contextlib import closing
from dataclasses import dataclass

@dataclass
class Record:
    handle: str
    owner: str
    provider: str
    config_dir: str
    needs_reauth: bool

_COLUMNS = "handle,owner,provider,config_dir,needs_reauth"

class SeatStore:
    def __init__(self, db_path: str):
        self._db_path = db_path
        with self._conn() as c:
            c.execute("""create table if not exists seats (
                handle text primary key, owner text not null, provider text not null,
                config_dir text not null, needs_reauth integer not null default 0)""")

    def _conn(self):
        # closing() actually closes the handle; a bare `with sqlite3.connect(...)`
        # only ends the transaction. isolation_level=None means autocommit.
        return closing(sqlite3.connect(self._db_path, isolation_level=None))

    def _row_to_record(self, row):
        if row is None:
            return None
        return Record(row[0], row[1], row[2], row[3], bool(row[4]))

    def put(self, owner: str, provider: str, config_dir: str) -> str:
        handle = secrets.token_urlsafe(32)
        with self._conn() as c:
            c.execute("insert into seats values (?,?,?,?,0)",
                      (handle, owner, provider, config_dir))
        return handle

    def get(self, handle: str):
        with self._conn() as c:
            row = c.execute(f"select {_COLUMNS} from seats where handle=?",
                            (handle,)).fetchone()
        return self._row_to_record(row)

    def find(self, owner: str, provider: str):
        with self._conn() as c:
            row = c.execute(f"select {_COLUMNS} from seats where owner=? and provider=?",
                            (owner, provider)).fetchone()
        return self._row_to_record(row)

    def mark_needs_reauth(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("update seats set needs_reauth=1 where handle=?", (handle,))

    def clear_needs_reauth(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("update seats set needs_reauth=0 where handle=?", (handle,))

    def delete(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("delete from seats where handle=?", (handle,))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_store.py -v`
Expected: 7 passed

- [ ] **Step 5: Update `test_relay.py` construction only**

In `seat-proxy/tests/test_relay.py`, every occurrence of
`TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())` becomes
`SeatStore(str(tmp_path / "s.db"))`, and every
`store.put("alice", "<provider>", "ACCESS", "R", 10_000.0)` becomes
`store.put("alice", "<provider>", str(tmp_path / "cfg"))`.
Update the import from `from seatproxy.store import TokenStore` to
`from seatproxy.store import SeatStore` and drop the now-unused
`from cryptography.fernet import Fernet`.

**Change nothing else in that file** — every assertion stays exactly as it is. Tests that
exercise refresh behaviour will be repaired in Task 4; if any fail after this step, note which
in your report and leave them failing.

- [ ] **Step 6: Run the relay tests and record the state**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_relay.py -v`
Expected: the tests that never reach `resolve_access_token` pass. Any failure must be a
`resolve_access_token` signature or token-source mismatch, which Task 4 fixes. Record exactly
which tests fail and why in your report.

- [ ] **Step 7: Commit**

```bash
git add seat-proxy/src/seatproxy/store.py seat-proxy/tests/test_store.py seat-proxy/tests/test_relay.py
git commit -m "refactor(seat-proxy): store becomes a handle map, tokens live in the CLI file"
```

---

### Task 4: Repoint refresh at the credentials file

`resolve_access_token` keeps its exact signature so `relay.py` needs no change. What changes is
where the tokens come from and where rotations go.

**Files:**
- Rewrite: `seat-proxy/src/seatproxy/refresh.py`
- Rewrite: `seat-proxy/tests/test_refresh.py`

**Interfaces:**
- Consumes: `SeatStore`, `Record` (Task 3); `read_tokens`, `write_tokens`, `SeatTokens`,
  `CredentialsMissing`, `CredentialsMalformed` (Task 2).
- Produces: `REFRESH_SKEW_SECONDS = 120`; `SeatNeedsReauth`; `SeatTemporarilyUnavailable`;
  `AuthRejected`; `async def resolve_access_token(store, handle, now, refresher) -> str`, where
  `refresher` is `async (provider: str, tokens: SeatTokens) -> SeatTokens`.
  Tasks 5 and 6 import `AuthRejected` from this module, so it must be defined here and not
  anywhere else.

The refcounted per-handle locking from the previous implementation is preserved verbatim — it was
reviewed and its invariant hand-traced. Only the token source changes.

`AuthRejected` is raised by provider modules (Task 5/6) to mean "the provider refused these
credentials"; anything else from a refresher is treated as transient.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_refresh.py  (replace the file entirely)
import asyncio, json, pytest
from seatproxy.store import SeatStore
from seatproxy.credentials import SeatTokens
from seatproxy.refresh import (
    resolve_access_token, SeatNeedsReauth, SeatTemporarilyUnavailable, AuthRejected)

def seat(tmp_path, access="OLD", refresh="R", expires_ms=0):
    cfg = tmp_path / "cfg"
    cfg.mkdir(exist_ok=True)
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": access, "refreshToken": refresh,
                           "expiresAt": expires_ms}}), encoding="utf-8")
    store = SeatStore(str(tmp_path / "s.db"))
    return store, store.put("alice", "anthropic", str(cfg)), cfg

async def never(provider, tokens):
    raise AssertionError("must not refresh")

@pytest.mark.asyncio
async def test_returns_existing_token_when_fresh(tmp_path):
    store, h, _ = seat(tmp_path, access="GOOD", expires_ms=10_000_000)
    assert await resolve_access_token(store, h, now=5_000.0, refresher=never) == "GOOD"

@pytest.mark.asyncio
async def test_refreshes_inside_skew_and_writes_back_to_the_cli_file(tmp_path):
    store, h, cfg = seat(tmp_path, expires_ms=5_060_000)   # 60s out, skew is 120s
    async def refresher(provider, tokens):
        assert provider == "anthropic"
        return SeatTokens("NEW", "NEWR", 9_000.0)
    assert await resolve_access_token(store, h, now=5_000.0, refresher=refresher) == "NEW"
    doc = json.loads((cfg / ".credentials.json").read_text(encoding="utf-8"))
    assert doc["claudeAiOauth"]["accessToken"] == "NEW"

@pytest.mark.asyncio
async def test_concurrent_calls_refresh_only_once(tmp_path):
    store, h, _ = seat(tmp_path)
    calls = []
    async def refresher(provider, tokens):
        calls.append(1)
        await asyncio.sleep(0.05)
        return SeatTokens("NEW", "NEWR", 9_000.0)
    out = await asyncio.gather(*[
        resolve_access_token(store, h, now=5_000.0, refresher=refresher) for _ in range(5)])
    assert out == ["NEW"] * 5 and len(calls) == 1

@pytest.mark.asyncio
async def test_auth_rejection_flags_needs_reauth(tmp_path):
    store, h, _ = seat(tmp_path)
    async def refresher(provider, tokens):
        raise AuthRejected()
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert store.get(h).needs_reauth is True

@pytest.mark.asyncio
async def test_transient_failure_does_not_brick_the_seat(tmp_path):
    store, h, _ = seat(tmp_path)
    async def refresher(provider, tokens):
        raise TimeoutError("network blip")
    with pytest.raises(SeatTemporarilyUnavailable):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert store.get(h).needs_reauth is False

@pytest.mark.asyncio
async def test_missing_credentials_file_means_reauth(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", str(tmp_path / "empty"))
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=never)

@pytest.mark.asyncio
async def test_already_flagged_seat_raises_without_reading(tmp_path):
    store, h, _ = seat(tmp_path, expires_ms=10_000_000)
    store.mark_needs_reauth(h)
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=never)

@pytest.mark.asyncio
async def test_successful_refresh_clears_a_stale_reauth_flag(tmp_path):
    store, h, _ = seat(tmp_path)
    store.clear_needs_reauth(h)
    async def refresher(provider, tokens):
        return SeatTokens("NEW", "NEWR", 9_000.0)
    await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert store.get(h).needs_reauth is False

@pytest.mark.asyncio
async def test_lock_table_is_emptied_after_use(tmp_path):
    from seatproxy import refresh as m
    store, h, _ = seat(tmp_path)
    async def refresher(provider, tokens):
        return SeatTokens("NEW", "NEWR", 9_000.0)
    await asyncio.gather(*[
        resolve_access_token(store, h, now=5_000.0, refresher=refresher) for _ in range(5)])
    assert m._locks == {} and m._waiters == {}

@pytest.mark.asyncio
async def test_lock_released_when_refresh_fails(tmp_path):
    from seatproxy import refresh as m
    store, h, _ = seat(tmp_path)
    async def refresher(provider, tokens):
        raise AuthRejected()
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert m._locks == {} and m._waiters == {}

@pytest.mark.asyncio
async def test_exceptions_carry_no_handle(tmp_path):
    store, h, _ = seat(tmp_path)
    async def refresher(provider, tokens):
        raise AuthRejected()
    with pytest.raises(SeatNeedsReauth) as exc:
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert h not in str(exc.value) and h not in repr(exc.value.args)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_refresh.py -v`
Expected: FAIL with `ImportError: cannot import name 'SeatTemporarilyUnavailable'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/refresh.py  (replace the file entirely)
"""Decide whether a seat's access token is usable, refreshing it when near expiry.

Tokens come from the provider CLI's own credentials file and rotations are written
back to it, so the user's CLI and the proxy never diverge.
"""

import asyncio

from .credentials import (
    CredentialsMalformed, CredentialsMissing, CredentialsUnreadable,
    read_tokens, write_tokens)

REFRESH_SKEW_SECONDS = 120

class SeatNeedsReauth(Exception):
    """The seat is unusable and the user must re-run the CLI login.

    Carries no handle or token: callers may log this exception.
    """

class SeatTemporarilyUnavailable(Exception):
    """A transient failure. The seat is fine; the caller should retry later.

    Kept distinct from SeatNeedsReauth so one network blip cannot brick a seat
    until manual re-enrollment.
    """

class AuthRejected(Exception):
    """Raised by a provider refresher when the provider refused the credentials."""

# Refcounted so the table does not grow without bound. Both helpers are fully
# synchronous — no await between reading and mutating the refcount — so under
# cooperative scheduling they are atomic, and a lock is only evicted once no
# coroutine still references it.
_locks: dict[str, asyncio.Lock] = {}
_waiters: dict[str, int] = {}

def _acquire_lock(handle: str) -> asyncio.Lock:
    lock = _locks.get(handle)
    if lock is None:
        lock = _locks[handle] = asyncio.Lock()
    _waiters[handle] = _waiters.get(handle, 0) + 1
    return lock

def _release_lock(handle: str) -> None:
    remaining = _waiters.get(handle, 1) - 1
    if remaining <= 0:
        _waiters.pop(handle, None)
        _locks.pop(handle, None)
    else:
        _waiters[handle] = remaining

def _load(rec):
    try:
        return read_tokens(rec.provider, rec.config_dir)
    except CredentialsUnreadable as exc:
        # Present but momentarily unreadable — the seat is fine, retry later.
        raise SeatTemporarilyUnavailable() from exc
    except (CredentialsMissing, CredentialsMalformed) as exc:
        # Absent or corrupt: only a fresh CLI login fixes this.
        raise SeatNeedsReauth() from exc

async def resolve_access_token(store, handle, now, refresher) -> str:
    rec = store.get(handle)
    if rec is None:
        raise SeatNeedsReauth()
    tokens = _load(rec)
    if rec.needs_reauth:
        # A flagged seat recovers by itself once the user re-runs the CLI login:
        # a readable, non-expired credentials file is proof the seat works again.
        # Without this the flag is permanent and re-enrolling would mint a new
        # handle that Cloudflare OS would have to be re-pointed at.
        if now < tokens.expires_at - REFRESH_SKEW_SECONDS:
            store.clear_needs_reauth(handle)
            return tokens.access_token
        raise SeatNeedsReauth()
    if now < tokens.expires_at - REFRESH_SKEW_SECONDS:
        return tokens.access_token

    lock = _acquire_lock(handle)
    try:
        async with lock:
            rec = store.get(handle)
            if rec is None or rec.needs_reauth:
                raise SeatNeedsReauth()
            tokens = _load(rec)
            # The CLI itself may have rotated while we queued, so re-read and re-check.
            if now < tokens.expires_at - REFRESH_SKEW_SECONDS:
                return tokens.access_token
            try:
                fresh = await refresher(rec.provider, tokens)
            except AuthRejected as exc:
                store.mark_needs_reauth(handle)
                raise SeatNeedsReauth() from exc
            except Exception:
                # Transport, timeout, anything else: the seat is not proven dead.
                # `from None`: httpx errors carry .request, whose body holds the
                # refresh token, and an attribute-serializing error reporter
                # would capture it off __cause__.
                raise SeatTemporarilyUnavailable() from None
            write_tokens(rec.provider, rec.config_dir, fresh)
            store.clear_needs_reauth(handle)
            return fresh.access_token
    finally:
        _release_lock(handle)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_refresh.py -v`
Expected: 11 passed

- [ ] **Step 5: Add the new failure mode to the relay**

`relay.py` currently catches `SeatNeedsReauth` then a bare `Exception` → 502. That already covers
`SeatTemporarilyUnavailable`, but a 502 with a clearer message is better. In `relay.py`, in the
`try` block around `resolve_access_token`, add this clause **between** the existing
`except SeatNeedsReauth:` and `except Exception:` clauses:

```python
    except SeatTemporarilyUnavailable:
        return provider_error(provider, 503, "api_error",
                              "Seat temporarily unavailable. Try again shortly.")
```

and extend the import at the top of `relay.py` to
`from .refresh import resolve_access_token, SeatNeedsReauth, SeatTemporarilyUnavailable`.
Change nothing else in `relay.py`.

- [ ] **Step 6: Run the full suite**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest -v`
Expected: all tests pass. If any `test_relay.py` test left failing by Task 3 still fails, fix the
test's construction only — never its assertions — and say so in your report.

- [ ] **Step 7: Commit**

```bash
git add seat-proxy/src/seatproxy/refresh.py seat-proxy/tests/test_refresh.py seat-proxy/src/seatproxy/relay.py
git commit -m "refactor(seat-proxy): refresh reads and writes the CLI credentials file"
```

---

### Task 5: Anthropic seat module

**Files:**
- Create: `seat-proxy/src/seatproxy/anthropic_seat.py`
- Test: `seat-proxy/tests/test_anthropic_seat.py`

**Interfaces:**
- Consumes: `SeatTokens`, `AuthRejected`.
- Produces: `CLIENT_ID`, `TOKEN_URL`, `UPSTREAM_BASE`, `SEAT_MODELS`,
  `async def refresh(client, tokens) -> SeatTokens`,
  `async def fetch_available_models(client, access_token) -> list[str]`.

Values verified against working code in
`OpenWhisperer/src-tauri/src/commands/sdk_cmds.rs:482-489, 580-660`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_anthropic_seat.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_anthropic_seat.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.anthropic_seat'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/anthropic_seat.py
"""Anthropic subscription-seat refresh.

Constants are Claude Code's own public OAuth client, verified against working
code in OpenWhisperer (src-tauri/src/commands/sdk_cmds.rs:482-489).
"""

import time

import httpx

from .credentials import SeatTokens
from .refresh import AuthRejected

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
UPSTREAM_BASE = "https://api.anthropic.com"

# Anthropic exposes no per-seat model list endpoint, so the catalog is static.
SEAT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]

async def refresh(client: httpx.AsyncClient, tokens: SeatTokens) -> SeatTokens:
    response = await client.post(TOKEN_URL, json={
        "grant_type": "refresh_token",
        "refresh_token": tokens.refresh_token,
        "client_id": CLIENT_ID,
    })
    # Only a genuine credential rejection means the seat is dead. 408 and 429 are
    # transient and must not brick a seat, and anything else 4xx falls through to
    # raise_for_status() and is treated as transient by the caller.
    if response.status_code in (400, 401, 403):
        raise AuthRejected()
    response.raise_for_status()
    data = response.json()
    return SeatTokens(
        data["access_token"],
        data.get("refresh_token") or tokens.refresh_token,
        time.time() + float(data["expires_in"]),
    )

async def fetch_available_models(client, access_token: str) -> list[str]:
    return list(SEAT_MODELS)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_anthropic_seat.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/anthropic_seat.py seat-proxy/tests/test_anthropic_seat.py
git commit -m "feat(seat-proxy): Anthropic seat refresh"
```

---

### Task 6: OpenAI/Codex seat module

**Files:**
- Create: `seat-proxy/src/seatproxy/openai_seat.py`
- Test: `seat-proxy/tests/test_openai_seat.py`

**Interfaces:**
- Consumes: `SeatTokens`, `AuthRejected`.
- Produces: `CLIENT_ID`, `TOKEN_URL`, `UPSTREAM_BASE`, `client_headers(access_token) -> dict`,
  `async def refresh(client, tokens) -> SeatTokens`,
  `async def fetch_available_models(client, access_token) -> list[str]`.

Values from `Odysseus/src/chatgpt_subscription.py:20-28, 78-87` and
`OpenWhisperer/src-tauri/src/commands/sdk_cmds.rs:805-816`.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_openai_seat.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_openai_seat.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.openai_seat'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/openai_seat.py
"""ChatGPT/Codex subscription-seat refresh.

Constants ported from Odysseus (src/chatgpt_subscription.py:20-28, 78-87), which
has a working implementation of this flow.
"""

import time

import httpx

from .credentials import SeatTokens
from .refresh import AuthRejected

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_URL = "https://auth.openai.com/oauth/token"
UPSTREAM_BASE = "https://chatgpt.com/backend-api/codex"

def client_headers(access_token: str | None) -> dict:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/codex",
        "User-Agent": "seat-proxy",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    return headers

async def refresh(client: httpx.AsyncClient, tokens: SeatTokens) -> SeatTokens:
    response = await client.post(
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token",
              "refresh_token": tokens.refresh_token,
              "client_id": CLIENT_ID})
    # Only a genuine credential rejection means the seat is dead. 408 and 429 are
    # transient and must not brick a seat, and anything else 4xx falls through to
    # raise_for_status() and is treated as transient by the caller.
    if response.status_code in (400, 401, 403):
        raise AuthRejected()
    response.raise_for_status()
    data = response.json()
    return SeatTokens(
        data["access_token"],
        data.get("refresh_token") or tokens.refresh_token,
        time.time() + float(data["expires_in"]),
    )

async def fetch_available_models(client: httpx.AsyncClient, access_token: str) -> list[str]:
    # A seat with no discoverable catalogue is still usable with a model typed by
    # hand, so a failure here must not block enrollment.
    try:
        response = await client.get(f"{UPSTREAM_BASE}/models",
                                    headers=client_headers(access_token))
        response.raise_for_status()
        return [m["slug"] for m in response.json().get("models", [])]
    except Exception:
        return []
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_openai_seat.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add seat-proxy/src/seatproxy/openai_seat.py seat-proxy/tests/test_openai_seat.py
git commit -m "feat(seat-proxy): OpenAI/Codex seat refresh"
```

---

### Task 7: Enrollment endpoints and app wiring

**Files:**
- Create: `seat-proxy/src/seatproxy/app.py`
- Test: `seat-proxy/tests/test_app.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `create_app(store, client, state_dir) -> FastAPI` exposing
  `POST /enroll/{provider}/start`, `POST /enroll/{provider}/poll`,
  `GET /enroll/{provider}/models`, `DELETE /enroll/{handle}`,
  and relay mounts `/anthropic/{path:path}`, `/openai/{path:path}`.
  Enrollment requires header `X-Seat-Owner` (the authenticated Cloudflare OS username).

The relay routes MUST pass `upstream_path=path` — the relay no longer derives it, and forwarding
the route prefix upstream was a defect caught in review.

- [ ] **Step 1: Write the failing test**

```python
# seat-proxy/tests/test_app.py
import json, httpx, pytest
from fastapi.testclient import TestClient
from seatproxy.store import SeatStore
from seatproxy.app import create_app

def build(tmp_path, handler=None):
    handler = handler or (lambda r: httpx.Response(200, json={}))
    store = SeatStore(str(tmp_path / "s.db"))
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_app(store, client, str(tmp_path / "state"))
    return store, TestClient(app)

def test_enroll_start_requires_owner_header(tmp_path):
    _, app = build(tmp_path)
    assert app.post("/enroll/anthropic/start").status_code == 400

def test_enroll_start_rejects_unknown_provider(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/bogus/start", headers={"X-Seat-Owner": "alice"})
    assert r.status_code == 400

def test_enroll_start_returns_the_login_command(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": "alice"})
    assert r.status_code == 200
    body = r.json()
    assert "CLAUDE_CONFIG_DIR=" in body["command"]
    assert body["command"].endswith("claude login")
    assert body["poll_id"]

def test_poll_reports_pending_until_credentials_appear(tmp_path):
    _, app = build(tmp_path)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    r = app.post("/enroll/anthropic/poll", json={"poll_id": start["poll_id"]})
    assert r.json()["status"] == "pending"

def test_poll_completes_once_credentials_exist(tmp_path):
    _, app = build(tmp_path)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    cfg = tmp_path / "state" / "alice" / "anthropic"
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "A", "refreshToken": "R",
                           "expiresAt": 9_000_000}}), encoding="utf-8")
    body = app.post("/enroll/anthropic/poll",
                    json={"poll_id": start["poll_id"]}).json()
    assert body["status"] == "complete"
    assert body["handle"]
    assert "claude-sonnet-5" in body["models"]

def test_delete_rejects_another_owners_handle(tmp_path):
    store, app = build(tmp_path)
    h = store.put("alice", "anthropic", str(tmp_path / "cfg"))
    assert app.delete(f"/enroll/{h}",
                      headers={"X-Seat-Owner": "mallory"}).status_code == 404
    assert store.get(h) is not None

def test_delete_revokes_own_handle(tmp_path):
    store, app = build(tmp_path)
    h = store.put("alice", "anthropic", str(tmp_path / "cfg"))
    assert app.delete(f"/enroll/{h}",
                      headers={"X-Seat-Owner": "alice"}).status_code == 204
    assert store.get(h) is None

def test_relay_route_does_not_forward_its_prefix(tmp_path):
    seen = {}
    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})
    store, app = build(tmp_path, handler)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "A", "refreshToken": "R",
                           "expiresAt": 99_000_000_000}}), encoding="utf-8")
    h = store.put("alice", "anthropic", str(cfg))
    app.post("/anthropic/v1/messages", headers={"x-api-key": h}, json={})
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seatproxy.app'`

- [ ] **Step 3: Write minimal implementation**

```python
# seat-proxy/src/seatproxy/app.py
"""HTTP surface: enrollment plus the two relay mounts."""

import os
import re
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Header, Request, Response

from . import anthropic_seat, openai_seat, providers
from .credentials import CredentialsMalformed, CredentialsMissing, read_tokens
from .errors import provider_error
from .relay import relay

_SEAT_MODULES = {providers.ANTHROPIC: anthropic_seat, providers.OPENAI: openai_seat}

# X-Seat-Owner is caller-supplied and lands in a filesystem path. Unvalidated, an
# owner of "../../../../home/someone/.claude" would not merely escape state_dir —
# poll() would mint a handle bound to that directory, letting the caller relay
# requests using whoever's seat lives there. Charset plus an explicit traversal
# reject, backed by a resolved-containment check below.
_OWNER_PATTERN = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")

_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

def _valid_owner(owner: str | None) -> bool:
    if not owner or not _OWNER_PATTERN.match(owner):
        return False
    if ".." in owner or owner in {".", ".."}:
        return False
    # Windows silently strips trailing dots and spaces from a path component, so
    # "alice." and "alice" name the SAME directory — verified on this host. Without
    # this reject, enrolling as "alice." would land in alice's directory, find her
    # credentials, and mint a handle to her seat.
    if owner[0] in ". " or owner[-1] in ". ":
        return False
    # Reserved device names raise OSError from mkdir; reject for a clean 400.
    if owner.split(".")[0].lower() in _WINDOWS_RESERVED:
        return False
    # The filesystem is case-insensitive on Windows and macOS, so "Alice" would
    # resolve into "alice"'s directory and read her credentials — while SQLite's
    # owner comparison stays case-sensitive, so her handle would not be revoked
    # and she would get no signal. Requiring a single canonical spelling removes
    # the alias rather than trying to keep two representations in sync.
    if owner != owner.casefold():
        return False
    return True

def create_app(store, client, state_dir: str) -> FastAPI:
    app = FastAPI()
    pending: dict[str, dict] = {}

    def config_dir_for(owner: str, provider: str) -> Path:
        # Belt and braces: even with a validated owner, confirm the resolved path
        # is still inside state_dir before anything is created or read.
        root = Path(state_dir).resolve()
        cfg = (root / owner / provider).resolve()
        if not cfg.is_relative_to(root):
            raise ValueError("config dir resolved outside the state directory")
        return cfg

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
        # Owner-only: these directories hold durable refresh tokens.
        try:
            os.chmod(cfg, 0o700)
        except OSError:
            pass          # best effort; Windows has no POSIX mode
        poll_id = secrets.token_urlsafe(16)
        pending[poll_id] = {"owner": x_seat_owner, "provider": provider,
                            "config_dir": str(cfg)}
        env = providers.CONFIG_DIR_ENV[provider]
        return {"poll_id": poll_id,
                "config_dir": str(cfg),
                "command": f'{env}="{cfg}" {providers.LOGIN_COMMAND[provider]}'}

    @app.post("/enroll/{provider}/poll")
    async def poll(provider: str, payload: dict):
        entry = pending.get(payload.get("poll_id", ""))
        if entry is None:
            return provider_error(provider, 404, "invalid_request_error",
                                  "Unknown poll_id.")
        try:
            tokens = read_tokens(entry["provider"], entry["config_dir"])
        except (CredentialsMissing, CredentialsMalformed):
            return {"status": "pending"}

        existing = store.find(entry["owner"], entry["provider"])
        if existing is not None:
            store.delete(existing.handle)
        handle = store.put(entry["owner"], entry["provider"], entry["config_dir"])
        pending.pop(payload["poll_id"], None)
        module = _SEAT_MODULES[entry["provider"]]
        models = await module.fetch_available_models(client, tokens.access_token)
        return {"status": "complete", "handle": handle, "models": models}

    @app.get("/enroll/{provider}/models")
    async def models(provider: str, handle: str):
        rec = store.get(handle)
        if rec is None or rec.provider != provider:
            return provider_error(provider, 404, "invalid_request_error",
                                  "Unknown handle.")
        try:
            tokens = read_tokens(rec.provider, rec.config_dir)
        except (CredentialsMissing, CredentialsMalformed):
            # The CLI login was removed or the file changed shape underneath us.
            return provider_error(provider, 401, "authentication_error",
                                  "Your subscription seat needs to be reconnected.")
        module = _SEAT_MODULES[rec.provider]
        return {"models": await module.fetch_available_models(client,
                                                              tokens.access_token)}

    @app.delete("/enroll/{handle}")
    async def revoke(handle: str, x_seat_owner: str | None = Header(default=None)):
        rec = store.get(handle)
        if rec is None or rec.owner != x_seat_owner:
            return provider_error(providers.ANTHROPIC, 404, "invalid_request_error",
                                  "Unknown handle.")
        store.delete(handle)
        return Response(status_code=204)

    @app.api_route("/anthropic/{path:path}", methods=["POST", "GET"])
    async def anthropic_relay(path: str, request: Request):
        return await relay(
            request, providers.ANTHROPIC, anthropic_seat.UPSTREAM_BASE, store, client,
            time.time(), upstream_path=path,
            refresher=lambda provider, tokens: anthropic_seat.refresh(client, tokens))

    @app.api_route("/openai/{path:path}", methods=["POST", "GET"])
    async def openai_relay(path: str, request: Request):
        return await relay(
            request, providers.OPENAI, openai_seat.UPSTREAM_BASE, store, client,
            time.time(), upstream_path=path,
            refresher=lambda provider, tokens: openai_seat.refresh(client, tokens))

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest tests/test_app.py -v`
Expected: 8 passed

- [ ] **Step 5: Run the whole suite**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest -v`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add seat-proxy/src/seatproxy/app.py seat-proxy/tests/test_app.py
git commit -m "feat(seat-proxy): enrollment endpoints and relay mounts"
```

---

### Task 8: Runnable service and documentation

**Files:**
- Create: `seat-proxy/main.py`, `seat-proxy/README.md`
- Modify: `seat-proxy/requirements.txt`

**Interfaces:**
- Consumes: `create_app` (Task 7).
- Produces: a service on `http://127.0.0.1:8890`.

- [ ] **Step 1: Write the entrypoint**

```python
# seat-proxy/main.py
import os

import httpx
import uvicorn

from seatproxy.app import create_app
from seatproxy.store import SeatStore

STATE_DIR = os.environ.get("SEAT_PROXY_STATE", "state")
DB_PATH = os.environ.get("SEAT_PROXY_DB", "seats.db")
PORT = int(os.environ.get("SEAT_PROXY_PORT", "8890"))

# 600s read timeout: a long completion must not be cut off mid-stream.
app = create_app(SeatStore(DB_PATH),
                 httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)),
                 STATE_DIR)

if __name__ == "__main__":
    # Bind loopback only: this service holds every enrolled user's refresh tokens
    # and has no authentication of its own beyond the handle.
    uvicorn.run(app, host="127.0.0.1", port=PORT)
```

- [ ] **Step 2: Update `requirements.txt`**

```
fastapi
uvicorn
httpx
pytest
pytest-asyncio
```

`cryptography` is no longer needed — the store holds no secrets. Remove it.

- [ ] **Step 3: Start the service**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python main.py`
Expected: `Uvicorn running on http://127.0.0.1:8890`

- [ ] **Step 4: Enroll a seat by hand**

```bash
curl -s -X POST localhost:8890/enroll/anthropic/start -H "X-Seat-Owner: admin"
# run the returned command in another terminal, complete the CLI login, then:
curl -s -X POST localhost:8890/enroll/anthropic/poll \
  -H "content-type: application/json" -d '{"poll_id":"<from start>"}'
```
Expected: `{"status":"complete","handle":"...","models":[...]}`

- [ ] **Step 5: Prove the relay end to end**

In the running Cloudflare OS instance: AI Providers → Add model → Anthropic →
**Advanced Settings → API URL** = `http://localhost:8890/anthropic`, API token = the handle.
Send a chat message.

Expected: a streaming reply. This is the proof the whole design works, with no fork changes.

- [ ] **Step 6: Verify no secrets are logged**

Run: `cd C:\Developer\cloudflare-os\seat-proxy && python -m pytest -q --showlocals 2>&1 | grep -ciE "sk-ant-|accessToken.:.[A-Za-z0-9]|refreshToken.:.[A-Za-z0-9]"`
Expected: `0`. The masking `__repr__` on `SeatTokens` is what makes this hold.

- [ ] **Step 7: Write the README**

Document: the env vars (`SEAT_PROXY_STATE`, `SEAT_PROXY_DB`, `SEAT_PROXY_PORT`), the enrollment
flow from steps 3-4, the Advanced Settings wiring from step 5, that each user's tokens live in
their own `state/<owner>/<provider>/` directory owned by the provider CLI, and that revoking a
seat is `DELETE /enroll/<handle>`. State plainly that the service binds loopback only and has no
authentication beyond the handle, so it must not be exposed to a network.

- [ ] **Step 8: Commit**

```bash
git add seat-proxy/main.py seat-proxy/README.md seat-proxy/requirements.txt
git commit -m "feat(seat-proxy): runnable service with setup docs"
```

---

## Out of scope

The Cloudflare OS fork (`seat-types.ts`, `seat-auth.ts`, `SeatSignInButtons.tsx`, five
touchpoints) is Plan 2. Splitting into one worker process per user, running as distinct OS users,
is deferred until scale justifies it — the `config_dir` on each record is the seam.
