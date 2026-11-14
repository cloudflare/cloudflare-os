import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ConnectedAccounts, ConnectedAccountsSnapshot } from './ConnectedAccounts'

export const ConnectedAccountsContext = createContext<ConnectedAccounts | null>(null)

const LOADING: ConnectedAccountsSnapshot = { status: 'loading' }
const nothing = () => () => {}
const loading = () => LOADING

/**
 * The user's connected accounts, live, from the one subscription `ConnectedAccountsProvider`
 * holds. Loading where there is none, such as in the gallery.
 */
export const useConnectedAccounts = (): ConnectedAccountsSnapshot => {
  const accounts = useContext(ConnectedAccountsContext)
  return useSyncExternalStore(accounts?.subscribe ?? nothing, accounts?.getSnapshot ?? loading)
}
