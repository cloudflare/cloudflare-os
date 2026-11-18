import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WaitingAsks, type WaitingSnapshot } from './WaitingAsks'

const WaitingAsksContext = createContext<WaitingAsks | null>(null)

// The first sweep waits for the page to have been drawn and its own reads made.
const FIRST_SWEEP_MS = 3000
// Coming back to the window after this long reads again.
const STALE_MS = 5 * 60_000

/**
 * Keeps count of what the user's gadgets wait on them for (`WaitingAsks`) for everything beneath
 * it: swept once the app has started, again when the window is come back to after a while, and
 * when a page that lists the gadgets asks (`useRefreshedWaitingAsks`). A new connection reads
 * through the new API from then on.
 */
export const WaitingAsksProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const latestApi = useRef(api)
  useLayoutEffect(() => {
    if (!reconnecting) latestApi.current = api
  }, [api, reconnecting])
  const [waiting] = useState(() => new WaitingAsks(() => latestApi.current))

  useEffect(() => {
    const first = setTimeout(() => void waiting.sweep(), FIRST_SWEEP_MS)
    const shown = () => {
      if (!document.hidden) void waiting.refresh(STALE_MS)
    }
    document.addEventListener('visibilitychange', shown)
    return () => {
      clearTimeout(first)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [waiting])

  return <WaitingAsksContext value={waiting}>{children}</WaitingAsksContext>
}

const NONE: WaitingSnapshot = { total: 0, byGadget: new Map() }
const nothing = () => () => {}
const none = () => NONE

/** What the user's gadgets wait on them for, live. Nothing waits, outside `WaitingAsksProvider`. */
export const useWaitingAsks = (): WaitingSnapshot => {
  const waiting = useContext(WaitingAsksContext)
  return useSyncExternalStore(waiting?.subscribe ?? nothing, waiting?.getSnapshot ?? none)
}

/**
 * Has the count read again, on a page that lists the gadgets, when it is older than `maxAgeMs`.
 * Once, as the page is shown.
 */
export const useRefreshedWaitingAsks = (maxAgeMs: number) => {
  const waiting = useContext(WaitingAsksContext)
  useEffect(() => {
    void waiting?.refresh(maxAgeMs)
  }, [waiting, maxAgeMs])
}

/** Where a gadget shown reports what it asks, if anywhere. */
export const useWaitingAsksReport = () => useContext(WaitingAsksContext)
