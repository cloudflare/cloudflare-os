import { useEffect, useRef } from 'react'

/** How often a tab that is shown checks for a deploy it has not noticed otherwise. */
export const SESSION_CHECK_INTERVAL_MS = 5 * 60_000

/**
 * Runs `check` while the tab is shown: as it is shown again, as the network comes back, and every
 * few minutes. Those are when a tab that outlived a deploy can notice it; a hidden one checks once
 * it is shown.
 */
export const useSessionCheck = (check: () => void) => {
  const latest = useRef(check)
  useEffect(() => {
    latest.current = check
  })

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'visible') latest.current()
    }
    document.addEventListener('visibilitychange', run)
    window.addEventListener('online', run)
    const interval = setInterval(run, SESSION_CHECK_INTERVAL_MS)
    return () => {
      document.removeEventListener('visibilitychange', run)
      window.removeEventListener('online', run)
      clearInterval(interval)
    }
  }, [])
}
