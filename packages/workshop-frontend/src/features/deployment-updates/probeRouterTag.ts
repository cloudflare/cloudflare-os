import { ROUTER_TAG_PROBE_PATH } from '@gadgets/workshop-shared/api'
import { getBackendHost } from '../../connectHandoff'

const PROBE_TIMEOUT_MS = 5_000

/**
 * Has the backend record the router's current version tag, ahead of an update status read: the
 * Workshop's calls travel over one WebSocket, which carries the router's tag only when it opens.
 * Best-effort, and never rejects: a failed probe leaves the tag the backend last recorded. The
 * answer is never read, so `no-cors` suffices where the backend is on another origin (Vite dev).
 */
export const probeRouterTag = async (): Promise<void> => {
  try {
    await fetch(`${window.location.protocol}//${getBackendHost()}${ROUTER_TAG_PROBE_PATH}`, {
      method: 'POST',
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    // The status read goes ahead with the tag already recorded.
  }
}
