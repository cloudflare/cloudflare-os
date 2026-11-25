import { createContext, useContext, useLayoutEffect, useRef } from 'react'

/** What the assistant's presence hands to the work log drawn inside it: where the mascot is to sit. */
export type PresenceSlot = {
  /** Say that the mascot is to sit at `element`; the returned function gives it up. */
  claim: (element: HTMLElement) => () => void
  /** The place the mascot has got to, and is at: none while it is on its way to another. */
  arrivedAt: HTMLElement | null
}

export const PresenceSlotContext = createContext<PresenceSlot | undefined>(undefined)

/** Undefined outside the presence, where the mascot is not in the log. */
export const usePresenceSlot = () => useContext(PresenceSlotContext)

/**
 * The room of the mark column the mascot sits in; the mascot itself is drawn by the presence, and carried
 * here. What is beside it, in the row, can wait for it with `group-has-data-waiting`.
 */
export const MascotSlot = ({ holdUntilArrived }: { holdUntilArrived?: boolean }) => {
  const presence = usePresenceSlot()
  const box = useRef<HTMLSpanElement>(null)
  const claim = presence?.claim
  useLayoutEffect(() => claim?.(box.current!), [claim])
  // For what is beside it to wait for it (the words of a row that has just come in): marked until it is there.
  const waiting = holdUntilArrived && !(box.current && presence?.arrivedAt === box.current)
  return <span ref={box} data-waiting={waiting ? '' : undefined} className="block size-7 shrink-0" />
}
