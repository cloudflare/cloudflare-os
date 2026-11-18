import { useEffect, useEffectEvent, useState } from 'react'

/** Time left, as a few figures that tick down: "4h 12m 9s", "12m 9s", "9s". */
export const formatCountdown = (ms: number) => {
  if (ms <= 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [hours > 0 && `${hours}h`, (hours > 0 || minutes > 0) && `${minutes}m`, `${seconds % 60}s`].filter(Boolean).join(' ')
}

/**
 * The milliseconds left until `until` (an ISO time), each second, or undefined while there is no
 * time to count down to. `onElapsed` is called once it is reached.
 */
export const useCountdown = (until: string | undefined, onElapsed?: () => void) => {
  const target = until === undefined ? Number.NaN : new Date(until).getTime()
  const valid = Number.isFinite(target)
  const [now, setNow] = useState(() => Date.now())
  const left = valid ? Math.max(0, target - now) : undefined
  const elapsed = left === 0
  const reached = useEffectEvent(() => onElapsed?.())

  useEffect(() => {
    if (!valid) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [valid, target])

  useEffect(() => {
    if (elapsed) reached()
  }, [elapsed])

  return left
}
