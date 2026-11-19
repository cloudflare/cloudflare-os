import { useEffect, useState } from 'react'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { ConnectedAccounts } from './ConnectedAccounts'
import { connectionsOf, unreachableServices, type ConnectedAccount, type Connection } from './connectionList'

export type ConnectionsState =
  | { status: 'loading' }
  | {
      status: 'ready'
      connections: Connection[]
      /** The services that could not be asked what they offer, by name, which are not listed. */
      unreachable: string[]
      /**
       * What can be added as it is has been asked for, whether or not it could be told: until then
       * a service of that kind may only not be listed yet.
       */
      complete: boolean
    }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * The accounts the user has connected and the services they could connect, read when mounted and
 * again on each new connection to the backend, with what was read before up meanwhile. The
 * accounts are kept up to date from then on, as one is connected in a window of its own and has
 * to show here when that is done.
 *
 * `reloadAddable` reads again which services can be added as they are, which the backend tells of
 * no change to: one of them is on offer again once its account is disconnected.
 */
export const useConnections = (): { state: ConnectionsState; reloadAddable: () => void } => {
  const { api, reconnecting } = useApi()
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>()
  const [addable, setAddable] = useState<GatekeeperVendorInfo[]>([])
  const [addableAsked, setAddableAsked] = useState(false)
  const [accounts, setAccounts] = useState<ConnectedAccount[]>()
  const [problem, setProblem] = useState<string>()
  // Bumped to ask again after a failure.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let cancelled = false
    const fail = (error: unknown) => {
      if (!cancelled) setProblem(error instanceof Error ? error.message : String(error))
    }
    api.listGatekeeperVendors().then((list) => {
      if (!cancelled) setVendors(list)
    }, fail)
    // Without them the page still lists everything else.
    api.listAddableGatekeepers().then((list) => {
      if (cancelled) return
      setAddable(list)
      setAddableAsked(true)
    }, () => {
      if (!cancelled) setAddableAsked(true)
    })
    // The user's own, not a workspace's, so no workspace restarting breaks it; the backend puts it
    // back itself after a restart of its own, and tells of every account again.
    const subscription = api.subscribeConnectedAccounts(new ConnectedAccounts((next) => {
      if (!cancelled) setAccounts(next)
    }))
    subscription.catch(fail)
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [api, reconnecting, attempt])

  const reloadAddable = () => {
    api.listAddableGatekeepers().then(setAddable, () => {})
  }
  const retry = () => {
    setProblem(undefined)
    setAttempt((current) => current + 1)
  }

  // What was read stays up when reading it again fails, as over a connection that then drops.
  const state: ConnectionsState = vendors && accounts
    ? { status: 'ready', connections: connectionsOf({ vendors, addable, accounts }), unreachable: unreachableServices(vendors), complete: addableAsked }
    : problem !== undefined
      ? { status: 'failed', message: problem, retry }
      : { status: 'loading' }
  return { state, reloadAddable }
}
