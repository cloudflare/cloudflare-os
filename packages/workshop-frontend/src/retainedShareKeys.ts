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

export function writeRetainedShareKey(workspaceId: string, entry: RetainedShareKey): void {
  try {
    window.sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(entry))
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

export function clearRetainedShareKey(workspaceId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(workspaceId))
  } catch {
    // Best-effort; see above.
  }
}

/** Sweep every retained share key, of any format version. Called on logout. */
export function clearAllRetainedShareKeys(): void {
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
