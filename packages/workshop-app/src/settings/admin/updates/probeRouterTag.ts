import { ROUTER_TAG_PROBE_PATH } from '@gadgets/workshop-shared/api'

const PROBE_TIMEOUT_MS = 5_000

/**
 * Has the backend record the router's current version tag, ahead of reading the update status:
 * the app's calls travel over one WebSocket, which carries the router's tag only when it opens.
 * The backend is on the page's own origin, as the connection is (`rpc/Connection.ts`). Never
 * rejects: a probe that fails leaves the tag the backend last recorded, and the read goes ahead.
 * Ported from the old app's `probeRouterTag.ts`.
 */
export const probeRouterTag = async (): Promise<void> => {
  try {
    await fetch(ROUTER_TAG_PROBE_PATH, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch {
    // The read goes ahead with the tag already recorded.
  }
}
