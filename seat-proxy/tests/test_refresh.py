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
async def test_already_flagged_seat_with_expired_credentials_still_raises(tmp_path):
    # A flagged seat is no longer a permanent door shut: it now reads the
    # credentials file to check whether a fresh CLI login already fixed things.
    # Only when those credentials are also expired/unreadable does it still raise.
    store, h, _ = seat(tmp_path, expires_ms=0)
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

@pytest.mark.asyncio
async def test_unreadable_credentials_are_transient_not_reauth(tmp_path, monkeypatch):
    from seatproxy import refresh as m
    from seatproxy.credentials import CredentialsUnreadable
    store, h, _ = seat(tmp_path)
    def boom(provider, config_dir):
        raise CredentialsUnreadable(provider)
    monkeypatch.setattr(m, "read_tokens", boom)
    with pytest.raises(SeatTemporarilyUnavailable):
        await resolve_access_token(store, h, now=5_000.0, refresher=never)
    assert store.get(h).needs_reauth is False

@pytest.mark.asyncio
async def test_flagged_seat_recovers_after_a_fresh_cli_login(tmp_path):
    store, h, _ = seat(tmp_path, access="FRESH", expires_ms=10_000_000)
    store.mark_needs_reauth(h)
    assert await resolve_access_token(store, h, now=5_000.0, refresher=never) == "FRESH"
    assert store.get(h).needs_reauth is False

@pytest.mark.asyncio
async def test_flagged_seat_with_expired_credentials_still_raises(tmp_path):
    store, h, _ = seat(tmp_path, expires_ms=0)
    store.mark_needs_reauth(h)
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=never)
