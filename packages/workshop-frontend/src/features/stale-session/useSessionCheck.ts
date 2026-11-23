import { useEffect, useRef } from 'react'

/** How often a visible tab checks for a deploy it has not noticed otherwise. */
export const SESSION_CHECK_INTERVAL_MS = 5 * 60_000

/**
 * Runs `check` while the tab is visible: when it becomes visible, when the network comes back, and
 * every SESSION_CHECK_INTERVAL_MS. These are the moments a tab that outlived a deploy can notice
 * it; a hidden tab checks once it is shown again.
 */
export const useSessionCheck = (check: () => void) => {
  const checkRef = useRef(check)
  checkRef.current = check

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'visible') checkRef.current()
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
