import { useEffect, useState } from 'react'
import { RpcTarget, type RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  UnreadStateSubscriber,
  UnreadThread,
  UserUnreadState,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

// Changes arrive one chat at a time but carry only read state, not titles or previews, so the
// list is fetched again after a short pause. The listing is answered from the user's own account
// without opening any workspace, so refetching is cheap.
const REFETCH_DELAY_MS = 250
const RESUBSCRIBE_DELAY_MS = 2_000

class ChangeListener extends RpcTarget implements UnreadStateSubscriber {
  constructor(private readonly changed: () => void, private readonly released: () => void) { super() }
  async updated(_state: UserUnreadState): Promise<void> { this.changed() }
  async summaryUpdated(): Promise<void> {}
  async chatUpdated(): Promise<void> { this.changed() }
  // The server lets go of the subscriber when the subscription ends, e.g. after a reset.
  [Symbol.dispose]() { this.released() }
}

/**
 * Every chat in the user's workspaces, most recently active first, kept live: the sidebar's list
 * of recent chats. `undefined` until the first listing arrives.
 */
export const useRecentChats = (authenticatedApi: RpcStub<AuthenticatedApi>): UnreadThread[] | undefined => {
  const [chats, setChats] = useState<{ api: RpcStub<AuthenticatedApi>; rows: UnreadThread[] }>()

  useEffect(() => {
    let active = true
    let refetchTimer: ReturnType<typeof setTimeout> | undefined
    let resubscribeTimer: ReturnType<typeof setTimeout> | undefined
    let subscription: RpcStub<{}> | undefined
    let fetching = false
    let fetchAgain = false

    const fetchRows = () => {
      if (fetching) { fetchAgain = true; return }
      fetching = true
      authenticatedApi.getChatThreads()
        .then(rows => { if (active) setChats({ api: authenticatedApi, rows }) })
        .catch(err => { if (active) logRpcFailure('Failed to list recent chats:', err) })
        .finally(() => {
          fetching = false
          if (active && fetchAgain) { fetchAgain = false; fetchRows() }
        })
    }
    const scheduleFetch = () => {
      if (!active || refetchTimer) return
      refetchTimer = setTimeout(() => { refetchTimer = undefined; fetchRows() }, REFETCH_DELAY_MS)
    }
    const resubscribeLater = (from: unknown) => {
      if (!active || (subscription as unknown) !== from) return
      subscription = undefined
      clearTimeout(resubscribeTimer)
      resubscribeTimer = setTimeout(subscribe, RESUBSCRIBE_DELAY_MS)
    }
    const subscribe = () => {
      const listener = new ChangeListener(scheduleFetch, () => resubscribeLater(next))
      // Same structural cast as UnreadStateBridge: an RpcTarget is passed where the API names a stub.
      const next = authenticatedApi.subscribeToUnreadState('all', listener as unknown as RpcStub<UnreadStateSubscriber>)
      subscription = next
      next.catch(err => {
        if (!active) return
        logRpcFailure('Failed to subscribe to recent chats:', err)
        resubscribeLater(next)
      })
    }

    fetchRows()
    subscribe()
    return () => {
      active = false
      clearTimeout(refetchTimer)
      clearTimeout(resubscribeTimer)
      subscription?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  return chats?.api === authenticatedApi ? chats.rows : undefined
}
