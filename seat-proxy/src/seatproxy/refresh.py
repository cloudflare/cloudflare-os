import asyncio

REFRESH_SKEW_SECONDS = 120

class SeatNeedsReauth(Exception):
    """The seat's tokens are unusable and the user must reconnect.

    Carries no handle or token in its payload: callers may log this exception,
    and its args must never contain a secret.
    """

# Refcounted so the table does not grow without bound on a long-running service.
# Both helpers are fully synchronous — no await between reading and mutating the
# refcount — so under asyncio's cooperative scheduling they are atomic, and a lock
# is only evicted once no coroutine still references it.
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

async def resolve_access_token(store, handle, now, refresher) -> str:
    rec = store.get(handle)
    if rec is None or rec.needs_reauth:
        raise SeatNeedsReauth()
    if now < rec.expires_at - REFRESH_SKEW_SECONDS:
        return rec.access_token

    lock = _acquire_lock(handle)
    try:
        async with lock:
            rec = store.get(handle)
            if rec is None or rec.needs_reauth:
                raise SeatNeedsReauth()
            # Another waiter may have refreshed while we queued.
            if now < rec.expires_at - REFRESH_SKEW_SECONDS:
                return rec.access_token
            try:
                access, refresh, expires_at = await refresher(rec)
            except Exception as exc:
                store.mark_needs_reauth(handle)
                raise SeatNeedsReauth() from exc
            store.update_tokens(handle, access, refresh, expires_at)
            return access
    finally:
        _release_lock(handle)
