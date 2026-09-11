// The sessionStorage tier of share-key retention (model and security notes: useWorkspaceOpen's
// retainedShareKeyRef). Its own module so useAuth can sweep entries on logout without importing
// the hook.
//
// Entries are stamped with the capturing session's userId and honored only by a session with the
// same identity, so a key never crosses users in a shared tab; logout sweeps the whole prefix.
//
// A duplicated tab copies sessionStorage, so a clear here cannot reach the copy directly. Two
// mitigations bound that: entries expire (RETAINED_SHARE_KEY_TTL_MS), and capture-scoped clears
// and the logout sweep are broadcast to sibling tabs (BroadcastChannel), reaching a live
// duplicate's storage entry, pending stamp, and in-memory ref alike. Residual: a duplicate
// unloaded at broadcast time that reactivates within the TTL can replay once. The link itself
// stays multi-use server-side (docs/sharing.md); a single-use retry capability would close both.
//
// All operations are best-effort: storage can be unavailable, and a lost key only costs a
// re-click of the invite link.

const RETAINED_SHARE_KEY_PREFIX = 'gadgets:retained-share-key:'
const V2_PREFIX = `${RETAINED_SHARE_KEY_PREFIX}v2:`

export type RetainedShareKey = {
  key: string
  /** The profile id of the user whose session captured the key. */
  userId: string
  /**
   * The capture (one fragment read) that owns this entry. Two captures can hold the same key (the
   * same link clicked again by the tab's next user), so attempt-owned clears scope by capture.
   */
  captureId: string
}

/**
 * How long a stored entry is honored after its stamp lands. A failed first open retried or
 * reloaded shortly after fits well inside it; a duplicated tab's copy replaying much later does
 * not.
 */
export const RETAINED_SHARE_KEY_TTL_MS = 15 * 60 * 1000

// The stored shape: the entry plus the stamp time the TTL is measured from.
type StoredRetainedShareKey = RetainedShareKey & { capturedAt: number }

function storageKey(workspaceId: string): string {
  return `${V2_PREFIX}${workspaceId}`
}

// Write invalidation. A capture stamps its entry asynchronously (identity resolves after the open
// is issued), so a clear can race a stamp still in flight, and the late stamp would resurrect the
// key the clear meant to discard. A pending write captures three generation counters and commits
// only while all still match; each clear scope bumps one: logout the global counter, a
// workspace-scoped clear (keyless success, identity-mismatch sweep) the workspace's, an
// attempt-owned clear the capture's. beginRetainedShareKeyWrite also bumps the workspace counter,
// so the newest capture owns the slot and an older capture's late stamp cannot overwrite it. The
// capture tier is keyed by capture id rather than by key so a successful attempt voids exactly
// its own pending stamp, never a concurrent newer capture's, even one of the same key. Kept here
// rather than in the hook because storage outlives any single attempt.
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

/**
 * Start a capture's write: bump the workspace generation (superseding every older pending stamp
 * for the workspace), clear the displaced stored entry, and capture the current generations for
 * {@link commitRetainedShareKeyWrite}. Clearing the entry now rather than when the new stamp
 * lands keeps a reload inside that identity round trip from replaying the older key.
 */
export function beginRetainedShareKeyWrite(
    workspaceId: string, captureId: string): RetainedShareKeyWrite {
  // Bump before removing so no in-flight commit lands between the two. The displaced entry is
  // cleared by capture id, which broadcasts: a duplicated tab holds a copy under the same id, and
  // once this tab has moved on no other clear reaches it. This tab's own ref already holds the
  // new capture, so the local notification drops nothing. The bare removal then covers an entry
  // the reader rejects (malformed or v1), which the capture-scoped clear cannot name.
  const workspaceGeneration = (workspaceGenerations.get(workspaceId) ?? 0) + 1
  workspaceGenerations.set(workspaceId, workspaceGeneration)
  const displaced = readRetainedShareKey(workspaceId)
  if (displaced) clearRetainedShareKey(workspaceId, displaced.captureId)
  try {
    window.sessionStorage.removeItem(storageKey(workspaceId))
  } catch {
    // Best-effort; see above.
  }
  return {
    workspaceId,
    captureId,
    globalGeneration,
    workspaceGeneration,
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
    // Lenient bounds only; the server validates the key itself. A v1 (bare-string) or malformed
    // entry reads as absent.
    if (typeof key === 'string' && key.length > 0 && key.length <= 128 &&
        typeof userId === 'string' && typeof captureId === 'string') {
      // Expiry bounds the duplicated-tab copy (module header). A missing or malformed stamp
      // expires too (NaN fails the comparison); the dead entry is removed rather than re-judged.
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

// Cross-tab clear propagation (module header). Exactly two scopes are broadcast: capture-scoped
// clears, because a duplicated tab's copy shares the original's captureId while an independent
// sibling capture (a different id, even of the same key) does not; and the logout sweep, because
// sibling tabs share the login session. Workspace-scoped clears name no capture and stay local
// (the hook precedes its keyless-success workspace clear with a capture-scoped clear of whatever
// entry is left, so every success path does broadcast). Received clears go through the same
// internal functions as local ones, without re-broadcasting; the payload is validated even though
// the channel is same-origin.
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

/**
 * A clear as seen by the in-memory tier: exactly the two broadcast scopes. A capture-scoped clear
 * is reported whether or not a stored entry matched it, since the hook's ref may hold the capture
 * with nothing in storage.
 */
export type RetainedShareKeyClear =
  | { scope: 'capture'; workspaceId: string; captureId: string }
  | { scope: 'all' }

const clearListeners = new Set<(clear: RetainedShareKeyClear) => void>()

/**
 * Observe capture-scoped clears and logout sweeps, local and received alike. This is how a
 * sibling tab's broadcast reaches the hook's in-memory ref, which no storage removal can touch.
 * Returns the unsubscribe.
 */
export function subscribeToRetainedShareKeyClears(
    listener: (clear: RetainedShareKeyClear) => void): () => void {
  clearListeners.add(listener)
  return () => { clearListeners.delete(listener) }
}

function notifyClearListeners(clear: RetainedShareKeyClear): void {
  for (const listener of clearListeners) {
    try {
      listener(clear)
    } catch (error) {
      // The storage removal and generation bump already happened; a failing listener must not
      // break the clear for the others.
      console.error('Retained share key clear listener failed:', error)
    }
  }
}

function applyCaptureClear(workspaceId: string, captureId: string): void {
  // The generation is bumped before the removal so no in-flight commit can land between the two.
  captureGenerations.set(captureId, (captureGenerations.get(captureId) ?? 0) + 1)
  const entry = readRetainedShareKey(workspaceId)
  if (!entry || entry.captureId === captureId) {
    try {
      window.sessionStorage.removeItem(storageKey(workspaceId))
    } catch {
      // Best-effort; see above.
    }
  }
  // Notified even when another capture's entry kept the slot: the in-memory tier may still hold
  // this capture, and listeners scope by capture id themselves.
  notifyClearListeners({ scope: 'capture', workspaceId, captureId })
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
  notifyClearListeners({ scope: 'all' })
}

/**
 * Discard a workspace's retained entry and void any in-flight stamp for it. With `onlyCapture`,
 * the clear is attempt-owned: that capture's generation is always bumped (voiding its own pending
 * stamp even when another capture's entry occupies the slot), the entry is removed only if absent
 * or owned by that capture, and the clear is broadcast to sibling tabs. A different capture's
 * entry and pending stamp, even one of the same key, are untouched; the workspace generation is
 * deliberately not bumped in this branch.
 */
export function clearRetainedShareKey(workspaceId: string, onlyCapture?: string): void {
  if (onlyCapture !== undefined) {
    applyCaptureClear(workspaceId, onlyCapture)
    const message: RetainedShareKeyClearMessage =
        { type: 'clear-capture', workspaceId, captureId: onlyCapture }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    clearChannel?.postMessage(message)
  } else {
    // Bump before removing, as in applyCaptureClear. Local only: this scope names no capture, so a
    // broadcast could not be applied precisely. After the hook's capture-scoped clear its
    // remaining job is voiding the workspace's pending stamps.
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
 * sibling tab. Called on logout.
 */
export function clearAllRetainedShareKeys(): void {
  applyClearAll()
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  clearChannel?.postMessage({ type: 'clear-all' } satisfies RetainedShareKeyClearMessage)
}
