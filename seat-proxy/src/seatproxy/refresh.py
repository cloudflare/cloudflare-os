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
                # `from None`: httpx errors carry .request, whose body holds the
                # refresh token, and an attribute-serializing reporter would
                # capture it off __cause__.
                raise SeatTemporarilyUnavailable() from None
            try:
                write_tokens(rec.provider, rec.config_dir, fresh)
            except Exception:
                # The provider has already invalidated the old refresh token, so a
                # failed write loses the new one. Surface it as transient rather
                # than marking the seat dead, and still serve this request.
                pass
            store.clear_needs_reauth(handle)
            return fresh.access_token
    finally:
        _release_lock(handle)
