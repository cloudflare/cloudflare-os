import { useEffect, useState } from 'react'

/** Re-renders its component each minute while `enabled`, so a relative age it shows stays current. */
export const useMinuteTick = (enabled = true) => {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setTick(tick => tick + 1), 60_000)
    return () => clearInterval(timer)
  }, [enabled])
}
