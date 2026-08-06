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
