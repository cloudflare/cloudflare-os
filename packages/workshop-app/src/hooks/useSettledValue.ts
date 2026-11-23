import { useEffect, useRef, useState } from 'react'
import { Settler, type SettlerOptions } from './settler'

/**
 * What `value` has settled on (see `Settler`), for a status or a state that changes faster than a
 * person can follow it. `undefined` is not something to settle on but its absence: it is returned
 * as it was last settled, and what comes after it is shown at once.
 */
export const useSettledValue = <T>(value: T | undefined, options: SettlerOptions, equals?: (a: T, b: T) => boolean) => {
  const [shown, setShown] = useState<T | undefined>(value)
  const settler = useRef<Settler<T>>(undefined)
  settler.current ??= new Settler<T>(options, setShown, equals)

  useEffect(() => {
    if (value === undefined) settler.current!.rest()
    else settler.current!.set(value)
  })
  useEffect(() => () => settler.current?.dispose(), [])
  return shown
}
