import { createContext, useContext, useLayoutEffect, useRef } from 'react'

// How far the mascot's middle has to be from a row's mark column for the row to be clear of it, in pixels:
// a little more than its own size, which is what it fills.
const CLEAR = 24

/** What the assistant's presence hands to the work log drawn inside it: where the mascot is to sit. */
export type PresenceSlot = {
  /** Say that the mascot is to sit at `element`; the returned function gives it up. */
  claim: (element: HTMLElement) => () => void
  /** The place the mascot has got to, and is at: none while it is on its way to another. */
  arrivedAt: HTMLElement | null
  /** Where the mascot is on the page at this moment, to see whether it is yet clear of somewhere. */
  where: () => DOMRect | undefined
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

/**
 * The room of a mark column the mascot has just been at, kept bare while it is still over it: `onClear` is
 * called once it has moved on from it, for what was to be there to come in. Called at once where it was
 * never there, or there is no mascot.
 */
export const LeavingSlot = ({ onClear }: { onClear: () => void }) => {
  const presence = usePresenceSlot()
  const box = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    let frame = 0
    const look = () => {
      frame = 0
      const mascot = presence?.where()
      const here = box.current?.getBoundingClientRect()
      if (!mascot || !here) return onClear()
      const apart = Math.hypot(mascot.left + mascot.width / 2 - (here.left + here.width / 2), mascot.top + mascot.height / 2 - (here.top + here.height / 2))
      if (apart > CLEAR) return onClear()
      frame = requestAnimationFrame(look)
    }
    look()
    return () => cancelAnimationFrame(frame)
  }, [presence, onClear])
  return <span ref={box} className="block size-7 shrink-0" />
}
