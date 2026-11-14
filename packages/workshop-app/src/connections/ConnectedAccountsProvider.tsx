import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { ConnectedAccounts } from './ConnectedAccounts'
import { ConnectedAccountsContext } from './ConnectedAccountsContext'

/**
 * Holds one subscription to the user's connected accounts for everything beneath it: the sidebar's
 * logos, the Connections page, and connecting something from a chat. A new connection subscribes
 * again, keeping the accounts shown until the server has listed them again.
 */
export const ConnectedAccountsProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  // The API it subscribes with, read when it does.
  const latestApi = useRef(api)
  const [accounts] = useState(() => new ConnectedAccounts((subscriber) => latestApi.current.subscribeConnectedAccounts(subscriber)))

  useEffect(() => {
    accounts.start()
    return () => accounts.stop()
  }, [accounts])

  // Over a lost connection it could only fail; the new connection's `api` subscribes again.
  useLayoutEffect(() => {
    if (reconnecting || latestApi.current === api) return
    latestApi.current = api
    accounts.restart()
  }, [api, reconnecting, accounts])

  return <ConnectedAccountsContext value={accounts}>{children}</ConnectedAccountsContext>
}
