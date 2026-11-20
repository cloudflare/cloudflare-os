import { useEffect, useState, type ReactNode } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { ConnectedAccounts } from '@/connections/ConnectedAccounts'
import { useApi } from '@/rpc/ApiContext'
import { GatekeeperAppsContext } from './GatekeeperAppsContext'

/**
 * Reads the management apps of the user's gatekeepers (`listGatekeeperApps()`) for everything
 * beneath it, on each new connection, with what was read before up meanwhile. An app comes with
 * its gatekeeper's account and goes with it, which the backend tells of no change to: so the list
 * is read again each time the user's accounts change (`subscribeConnectedAccounts()`), as when a
 * tool is turned on in the connections or by an agent, or an account disconnected. What could not
 * be read leaves what was.
 */
export const GatekeeperAppsProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [apps, setApps] = useState<readonly GatekeeperAppInfo[]>([])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let cancelled = false
    // Only the latest read is shown, as an earlier one may answer after it.
    let reads = 0
    const read = () => {
      const asked = ++reads
      api.listGatekeeperApps().then((list) => {
        if (!cancelled && asked === reads) setApps(list)
      }, () => {})
    }
    // Which accounts there are, and not what is said of them, such as that one needs signing in to again.
    let accounts: string | undefined
    const subscription = api.subscribeConnectedAccounts(new ConnectedAccounts((next) => {
      const now = next.map(({ id }) => id).toSorted((a, b) => a - b).join(' ')
      const changed = accounts !== undefined && accounts !== now
      accounts = now
      if (changed && !cancelled) read()
    }))
    subscription.catch(() => {})
    read()
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [api, reconnecting])

  return <GatekeeperAppsContext value={apps}>{children}</GatekeeperAppsContext>
}
