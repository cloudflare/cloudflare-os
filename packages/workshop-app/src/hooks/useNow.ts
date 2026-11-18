import { useEffect, useState } from 'react'

/**
 * The time, moved on every `every` milliseconds while mounted, for what says how long ago
 * something was, or how soon it will be, so that it stays true while it is shown.
 */
export const useNow = (every = 30_000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(tick)
  }, [every])
  return now
}
