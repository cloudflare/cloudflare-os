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

@pytest.mark.asyncio
async def test_lock_table_is_emptied_after_use(tmp_path):
    from seatproxy import refresh as refresh_mod
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 0.0)
    async def refresher(rec):
        return ("NEW", "R2", 9_000.0)
    await asyncio.gather(*[
        resolve_access_token(store, h, now=5_000.0, refresher=refresher) for _ in range(5)])
    assert refresh_mod._locks == {}
    assert refresh_mod._waiters == {}

@pytest.mark.asyncio
async def test_lock_released_even_when_refresh_fails(tmp_path):
    from seatproxy import refresh as refresh_mod
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 0.0)
    async def refresher(rec):
        raise RuntimeError("revoked")
    with pytest.raises(SeatNeedsReauth):
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert refresh_mod._locks == {}
    assert refresh_mod._waiters == {}

@pytest.mark.asyncio
async def test_exception_payload_carries_no_handle(tmp_path):
    store = make_store(tmp_path)
    h = store.put("alice", "anthropic", "OLD", "R", 0.0)
    async def refresher(rec):
        raise RuntimeError("revoked")
    with pytest.raises(SeatNeedsReauth) as exc:
        await resolve_access_token(store, h, now=5_000.0, refresher=refresher)
    assert h not in str(exc.value)
    assert h not in repr(exc.value.args)
