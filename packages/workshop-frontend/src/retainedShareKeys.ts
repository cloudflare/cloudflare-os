// The sessionStorage tier of share-key retention (see useWorkspaceOpen's retainedShareKeyRef for
// the model and the security notes). Split into its own module so useAuth can sweep the entries
// on logout without importing the workspace hook.
//
// Entries are identity-stamped: each stores the userId of the session that captured the key, and
// readers only honor an entry whose stamp matches the current session's identity. That is what
// keeps a key from crossing users in a shared tab -- user A's retained key must not be silently
// re-redeemed under user B's account. Logout additionally sweeps the whole prefix
// (clearAllRetainedShareKeys), which also collects stale entries from older storage formats.
//
// A duplicated tab copies sessionStorage, so an entry cleared here can live on in the copy and
// silently re-redeem the still-live link on the duplicate's next revocation-restart reconnect --
// notably after an owner removes the collaborator. Two mitigations bound that: entries expire
// (RETAINED_SHARE_KEY_TTL_MS), so a copy cannot replay long after the capture, and capture-scoped
// clears plus the logout sweep are broadcast to sibling same-origin tabs (BroadcastChannel),
// clearing a duplicate's copy the moment the original's open succeeds. Residual: a duplicate
// discarded or unloaded at broadcast time that reactivates within the TTL can still replay once.
// The link itself deliberately stays multi-use server-side (docs/sharing.md carries the matching
// manual re-redeem residual); a single-use server-side retry capability would close both and is a
// possible kernel-side follow-up, not attempted here.
//
// All operations are best-effort: storage can be unavailable in restricted browser contexts, and
// a lost key only costs the user a re-visit of their invite link.

const RETAINED_SHARE_KEY_PREFIX = 'gadgets:retained-share-key:'
const V2_PREFIX = `${RETAINED_SHARE_KEY_PREFIX}v2:`

export type RetainedShareKey = {
  key: string
  /** The profile id of the user whose session captured the key. */
  userId: string
  /**
   * The unique id of the capture (one fragment read) that owns this entry. Ownership is by
   * capture rather than by raw key because two captures can hold the *same* key -- a second user
   * clicking the same invite link in the same tab -- and an attempt-owned clear must touch only
   * its own capture's retention, never a same-key successor's.
   */
  captureId: string
}

/**
 * How long a stored entry stays honored, from the moment its identity stamp is written. The
 * legitimate flow -- a failed first open retried or reloaded shortly after -- fits well inside
 * it; a duplicated tab's copied entry replaying after a later collaborator removal does not.
 */
export const RETAINED_SHARE_KEY_TTL_MS = 15 * 60 * 1000

// The stored shape: the entry plus the stamp time the TTL is measured from.
type StoredRetainedShareKey = RetainedShareKey & { capturedAt: number }

function storageKey(workspaceId: string): string {
  return `${V2_PREFIX}${workspaceId}`
}

// Write invalidation. A capture stamps its entry asynchronously (the identity resolves after the
// open is issued, to keep the open pipelined), so a clear can race a stamp still in flight: an
// attempt's success -- or logout -- clears storage, then the older attempt's identity resolves
// and writes the entry back, resurrecting a key whose link the redeemed edge already covers (or
// that logout meant to sweep). Generations close that: a pending write captures the counters at
// capture time and commits only while all still match, so any later clear permanently
// invalidates it. Three tiers, matching the three clear scopes: a global counter (logout sweeps
// everything), a per-workspace counter (workspace-wide clears -- a keyless success, an
// identity-mismatch sweep), and a per-capture counter for attempt-owned clears. The
// capture-scoped tier is what lets a confirmed attempt void *its own* in-flight stamp even when a
// newer capture's entry occupies the slot -- without it, the confirmed key's late
// stamp overwrites the newer entry and resurrects a key whose link would silently re-redeem
// after an owner removal; and conversely it leaves every other capture's pending stamp intact, so
// an attempt-owned clear can never void a concurrent newer capture -- not even one that captured
// the *same* key, which is why the tier is keyed by capture id rather than by the raw key. Kept
// here rather than in the capturing hook because the storage outlives any single attempt -- a
// per-attempt flag can only guard its own attempt's writes.
let globalGeneration = 0
const workspaceGenerations = new Map<string, number>()
const captureGenerations = new Map<string, number>()

/** A capture's license to write: void once it, its workspace, or everything is cleared. */
export type RetainedShareKeyWrite = {
  workspaceId: string
  captureId: string
  globalGeneration: number
  workspaceGeneration: number
  captureGeneration: number
}

/** Capture the current generations; pass the token to {@link commitRetainedShareKeyWrite}. */
export function beginRetainedShareKeyWrite(
    workspaceId: string, captureId: string): RetainedShareKeyWrite {
  return {
    workspaceId,
    captureId,
    globalGeneration,
    workspaceGeneration: workspaceGenerations.get(workspaceId) ?? 0,
    captureGeneration: captureGenerations.get(captureId) ?? 0,
  }
}

/** Write the entry unless a clear has landed since the token was taken. */
export function commitRetainedShareKeyWrite(
    token: RetainedShareKeyWrite, entry: RetainedShareKey): void {
  if (token.globalGeneration !== globalGeneration ||
      token.workspaceGeneration !== (workspaceGenerations.get(token.workspaceId) ?? 0) ||
      token.captureGeneration !== (captureGenerations.get(token.captureId) ?? 0)) {
    return
  }
  const stored: StoredRetainedShareKey = { ...entry, capturedAt: Date.now() }
  try {
    window.sessionStorage.setItem(storageKey(token.workspaceId), JSON.stringify(stored))
  } catch {
    // Best-effort; see above.
  }
}

export function readRetainedShareKey(workspaceId: string): RetainedShareKey | undefined {
  try {
    const raw = window.sessionStorage.getItem(storageKey(workspaceId))
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { key, userId, captureId, capturedAt } = parsed as
        { key?: unknown; userId?: unknown; captureId?: unknown; capturedAt?: unknown }
    // Lenient bounds only -- the server is the validator of record for the key itself. A v1
    // (bare-string) or otherwise malformed entry fails the shape check and reads as absent.
    if (typeof key === 'string' && key.length > 0 && key.length <= 128 &&
        typeof userId === 'string' && typeof captureId === 'string') {
      // Expiry bounds the duplicated-tab copy (see the module header). A missing or malformed
      // stamp time expires too (NaN fails the comparison), and the dead entry is removed rather
      // than left to be re-judged forever.
      if (typeof capturedAt !== 'number' ||
          !(Date.now() - capturedAt <= RETAINED_SHARE_KEY_TTL_MS)) {
        window.sessionStorage.removeItem(storageKey(workspaceId))
        return undefined
      }
      return { key, userId, captureId }
    }
  } catch {
    // Best-effort; see above (JSON.parse failure on a v1 entry lands here too).
  }
  return undefined
}

// Cross-tab clear propagation (see the module header): a duplicated tab copies this tab's
// sessionStorage, entry and captureId both, so the copies answer to the same clears. Exactly two
// scopes are broadcast. Capture-scoped clears, because the copy shares the original's captureId:
// the broadcast clears duplicates the moment the original's open succeeds, while an independent
// sibling capture -- a different captureId, even of the same key -- survives; workspace-scoped
// clears name no capture and so deliberately stay local. And the logout sweep, because sibling
// tabs share the login session. The handler applies clears through the same internal functions
// the local clears use, without re-broadcasting; the payload is validated defensively even
// though the channel is same-origin.
type RetainedShareKeyClearMessage =
  | { type: 'clear-capture'; workspaceId: string; captureId: string }
  | { type: 'clear-all' }

const clearChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('gadgets:retained-share-keys')
    : undefined
if (clearChannel) {
  // Node's implementation (vitest) would otherwise hold the event loop open; browsers have no
  // unref, hence the optional call.
  (clearChannel as { unref?: () => void }).unref?.()
  clearChannel.addEventListener('message', event => {
    const data = event.data as
        { type?: unknown; workspaceId?: unknown; captureId?: unknown } | null
    if (typeof data !== 'object' || data === null) return
    if (data.type === 'clear-capture' &&
        typeof data.workspaceId === 'string' && typeof data.captureId === 'string') {
      applyCaptureClear(data.workspaceId, data.captureId)
    } else if (data.type === 'clear-all') {
      applyClearAll()
    }
  })
}

// BroadcastChannel.postMessage takes no targetOrigin (the unicorn rule is written for
// window.postMessage), hence the disables at the two send sites below.

function applyCaptureClear(workspaceId: string, captureId: string): void {
  // The generation is bumped before the removal so no in-flight commit can land between the two.
  captureGenerations.set(captureId, (captureGenerations.get(captureId) ?? 0) + 1)
  const entry = readRetainedShareKey(workspaceId)
  if (entry && entry.captureId !== captureId) return
  try {
    window.sessionStorage.removeItem(storageKey(workspaceId))
  } catch {
    // Best-effort; see above.
  }
}

function applyClearAll(): void {
  globalGeneration++
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i)
      if (key?.startsWith(RETAINED_SHARE_KEY_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) window.sessionStorage.removeItem(key)
  } catch {
    // Best-effort; see above.
  }
}

/**
 * Discard a workspace's retained entry and void any in-flight identity stamp for it. With
 * `onlyCapture`, the clear is attempt-owned and touches exactly that capture's retention: its
 * per-capture generation is *always* bumped -- voiding the calling capture's own
 * in-flight stamp even when a different capture already occupies the entry, whose late landing
 * would otherwise resurrect a key the server confirmed -- while the entry is removed only when it
 * is absent or carries `onlyCapture`. A different-capture entry (even one holding the *same* key
 * -- a later user's capture of the same invite link), and every other capture's pending stamp,
 * are untouched: a newer capture owns the slot, and the workspace generation is deliberately not
 * bumped in this branch so an attempt-owned clear can never void a concurrent newer capture's
 * stamp. A capture-scoped clear is additionally broadcast to sibling tabs, which clears a
 * duplicated tab's copy of the entry (same captureId) with the same precision.
 */
export function clearRetainedShareKey(workspaceId: string, onlyCapture?: string): void {
  if (onlyCapture !== undefined) {
    applyCaptureClear(workspaceId, onlyCapture)
    const message: RetainedShareKeyClearMessage =
        { type: 'clear-capture', workspaceId, captureId: onlyCapture }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    clearChannel?.postMessage(message)
  } else {
    // The generation is bumped before the removal; see applyCaptureClear.
    workspaceGenerations.set(workspaceId, (workspaceGenerations.get(workspaceId) ?? 0) + 1)
    try {
      window.sessionStorage.removeItem(storageKey(workspaceId))
    } catch {
      // Best-effort; see above.
    }
  }
}

/**
 * Sweep every retained share key, of any format version, in this tab and (broadcast) every
 * sibling tab -- they share the login session logout just ended. Called on logout.
 */
export function clearAllRetainedShareKeys(): void {
  applyClearAll()
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  clearChannel?.postMessage({ type: 'clear-all' } satisfies RetainedShareKeyClearMessage)
}
