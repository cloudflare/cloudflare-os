import { useCallback, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

// The count last read, with the session it was read over and the number of the read that answered
// it: a count is one user's, so it is shown only under the session that read it.
let held: { api: RpcStub<AuthenticatedApi>; count: number; read: number } | undefined
// Numbers the reads, so that an answer a later read overtook is dropped.
let reads = 0
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const read = async (api: RpcStub<AuthenticatedApi>) => {
  const mine = ++reads
  let count: number
  try {
    count = await api.getUnseenIssueReportCount()
  } catch (err) {
    // The count last shown stays: the next read replaces it.
    logRpcFailure('Failed to read the count of issue reports with a new reply:', err)
    return
  }
  if (mine !== reads) return
  held = { api, count, read: mine }
  for (const listener of listeners) listener()
}

/**
 * How many of the user's issue reports hold a reply from an admin they have not seen, and the way
 * to have it read again. The server does not push the count, so whatever changes it asks for a
 * refresh: filing a report, and marking one seen. Every consumer shows the one count.
 *
 * `read` differs for every read that answered, whether or not the count did (0 before the first),
 * for a consumer that shows more than the count to read that again too: a report that was filed
 * leaves the count as it was.
 */
export const useIssueReportCount = (): { count: number; read: number; refresh: () => void } => {
  const { authenticatedApi } = useAuthenticatedApi()
  const current = useSyncExternalStore(subscribe, () => held)
  // Stable for one session, so that an Effect which refreshes on a timer is not restarted by
  // every render.
  const refresh = useCallback(() => { void read(authenticatedApi) }, [authenticatedApi])
  const mine = current?.api === authenticatedApi ? current : undefined
  return { count: mine?.count ?? 0, read: mine?.read ?? 0, refresh }
}
