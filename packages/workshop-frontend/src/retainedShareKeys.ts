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
// All operations are best-effort: storage can be unavailable in restricted browser contexts, and
// a lost key only costs the user a re-visit of their invite link.

const RETAINED_SHARE_KEY_PREFIX = 'gadgets:retained-share-key:'
const V2_PREFIX = `${RETAINED_SHARE_KEY_PREFIX}v2:`

export type RetainedShareKey = {
  key: string
  /** The profile id of the user whose session captured the key. */
  userId: string
}

function storageKey(workspaceId: string): string {
  return `${V2_PREFIX}${workspaceId}`
}

// Write invalidation. A capture stamps its entry asynchronously (the identity resolves after the
// open is issued, to keep the open pipelined), so a clear can race a stamp still in flight: an
// attempt's success -- or logout -- clears storage, then the older attempt's identity resolves
// and writes the entry back, resurrecting a key whose link the redeemed edge already covers (or
// that logout meant to sweep). Generations close that: a pending write captures the counters at
// capture time and commits only while both still match, so any later clear permanently
// invalidates it. Kept here rather than in the capturing hook because the storage outlives any
// single attempt -- a per-attempt flag can only guard its own attempt's writes.
let globalGeneration = 0
const workspaceGenerations = new Map<string, number>()

/** A capture's license to write: void once the workspace (or everything) is cleared. */
export type RetainedShareKeyWrite = {
  workspaceId: string
  globalGeneration: number
  workspaceGeneration: number
}

/** Capture the current generations; pass the token to {@link commitRetainedShareKeyWrite}. */
export function beginRetainedShareKeyWrite(workspaceId: string): RetainedShareKeyWrite {
  return {
    workspaceId,
    globalGeneration,
    workspaceGeneration: workspaceGenerations.get(workspaceId) ?? 0,
  }
}

/** Write the entry unless a clear has landed since the token was taken. */
export function commitRetainedShareKeyWrite(
    token: RetainedShareKeyWrite, entry: RetainedShareKey): void {
  if (token.globalGeneration !== globalGeneration ||
      token.workspaceGeneration !== (workspaceGenerations.get(token.workspaceId) ?? 0)) {
    return
  }
  try {
    window.sessionStorage.setItem(storageKey(token.workspaceId), JSON.stringify(entry))
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
    const { key, userId } = parsed as { key?: unknown; userId?: unknown }
    // Lenient bounds only -- the server is the validator of record for the key itself. A v1
    // (bare-string) or otherwise malformed entry fails the shape check and reads as absent.
    if (typeof key === 'string' && key.length > 0 && key.length <= 128 &&
        typeof userId === 'string') {
      return { key, userId }
    }
  } catch {
    // Best-effort; see above (JSON.parse failure on a v1 entry lands here too).
  }
  return undefined
}

/**
 * Discard a workspace's retained entry and void any in-flight identity stamp for it. With
 * `onlyKey`, the clear is attempt-owned: when the stored entry carries a *different* key, a newer
 * capture owns the slot, so nothing happens -- no removal, and no generation bump that would void
 * that capture's still-in-flight stamp. An *absent* entry still bumps, fail-toward-security: the
 * absence may be the calling attempt's own stamp still in flight, whose late landing would
 * resurrect a key the server already confirmed. The residual is that this bump can instead void a
 * concurrent newer attempt's in-flight stamp for the same workspace; recovery is re-clicking the
 * invite link, consistent with every other lost-retention path here.
 */
export function clearRetainedShareKey(workspaceId: string, onlyKey?: string): void {
  if (onlyKey !== undefined) {
    const entry = readRetainedShareKey(workspaceId)
    if (entry && entry.key !== onlyKey) return
  }
  // Bumped before the removal so no in-flight commit can land between the two.
  workspaceGenerations.set(workspaceId, (workspaceGenerations.get(workspaceId) ?? 0) + 1)
  try {
    window.sessionStorage.removeItem(storageKey(workspaceId))
  } catch {
    // Best-effort; see above.
  }
}

/** Sweep every retained share key, of any format version. Called on logout. */
export function clearAllRetainedShareKeys(): void {
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
