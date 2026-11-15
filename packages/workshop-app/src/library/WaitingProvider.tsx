import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { Waiting, type WaitingSnapshot } from './Waiting'

const WaitingContext = createContext<Waiting | null>(null)

/**
 * Keeps count of what the user's gadgets have waiting on them (`Waiting`) for everything beneath
 * it. A new connection reads it again, keeping what is shown.
 */
export const WaitingProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const latestApi = useRef(api)
  const [waiting] = useState(() => new Waiting(() => latestApi.current.listOutputs()))

  useEffect(() => {
    waiting.start()
    return () => waiting.stop()
  }, [waiting])

  // Over a lost connection it could only fail; the new connection's `api` reads it again.
  useLayoutEffect(() => {
    if (reconnecting || latestApi.current === api) return
    latestApi.current = api
    waiting.start()
  }, [api, reconnecting, waiting])

  return <WaitingContext value={waiting}>{children}</WaitingContext>
}

const NONE: WaitingSnapshot = { total: 0, gadgets: 0 }
const nothing = () => () => {}

/**
 * What the user's gadgets have waiting on them, live, and the way to read it again, as after a
 * decision. Nothing waits, outside `WaitingProvider`.
 */
export const useWaiting = (): { snapshot: WaitingSnapshot; refresh: () => void } => {
  const waiting = useContext(WaitingContext)
  const snapshot = useSyncExternalStore(waiting?.subscribe ?? nothing, waiting?.getSnapshot ?? (() => NONE))
  const refresh = useCallback(() => void waiting?.refresh(), [waiting])
  return { snapshot, refresh }
}
