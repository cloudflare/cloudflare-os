import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Collapsible } from '@cloudflare/kumo/primitives/collapsible'
import { useHandler } from '@/hooks/useHandler'
import { useSettledValue } from '@/hooks/useSettledValue'
import { useFlight } from '@/hooks/useFlight'
import { useReducedMotion } from '@gadgets/ui'
import { ArrowDown01Icon } from '@/components/icons'
import { Mascot } from '@/components/mascot/Mascot'
import { ShimmerSwitchText } from '@/components/ShimmerSwitchText'
import '@/components/Disclosure.css'
import { PresenceSlotContext, type PresenceSlot } from './presenceSlot'
import './AssistantPresence.css'

export type AssistantPresenceProps = {
  /** The assistant is working on its reply. */
  working: boolean
  /** What it is doing right now, e.g. "Running code". It has no closing "…": the wave says it is under way. */
  status?: string
  /**
   * It is writing the reply, rather than thinking about it or working at something: the mascot
   * turns to typing dots while it is, and back when it is not.
   */
  writing?: boolean
  /**
   * What is behind the status, shown when it is clicked, in place of the status's words and under a heading
   * that puts it away: the mascot is the last row of it (`WorkLog` finds its place through `PresenceSlotContext`). Without it the status
   * is only text.
   */
  details?: {
    open: boolean
    onToggle: () => void
    content: ReactNode
    /**
     * What it showed went into the reply that has just arrived, open above it: the steps go at once as they
     * close rather than fading, as they are there already, and only their room closes.
     */
    handedOver?: boolean
  }
}

// What the status says is settled on, not followed: a status that changes faster than it can be read
// is shown once it has held still for a moment, and never held at one thing for longer than a little
// while it keeps changing (`hooks/settler.ts`). What it says first, and first after it was away, is
// shown at once.
const SETTLE = { wait: 600, maxWait: 1800 }
const sameStatus = (a: { status: string; writing: boolean }, b: { status: string; writing: boolean }) => a.status === b.status && a.writing === b.writing

/**
 * The assistant at work, at the end of the conversation: the mascot grows in when a reply is on
 * its way, with what it is doing beside it (shimmering while it works), and shrinks
 * away once it is done. Its status is in 14px beside a 32px mascot; the steps are in 13px. How the reply comes about can be looked into only here, while it happens.
 *
 * Opened, the steps take the place of that line, which they say and more, under a Thinking details heading
 * that closes them again, and the mascot is carried down to the last row of them, its own, after them all
 * (`useFlight`), which the steps come in above, and back up when they are put away.
 *
 * Its room is always kept, so the mascot coming and going moves nothing, and the conversation
 * ends in that much space while it is away.
 */
export const AssistantPresence = ({ working, status, writing, details }: AssistantPresenceProps) => {
  const now = useMemo(() => (status === undefined ? undefined : { status, writing: Boolean(writing) }), [status, writing])
  // The last thing it said stays written while it fades out.
  const settled = useSettledValue(now, SETTLE, sameStatus)
  const words = settled?.status
  const expanded = !!details && working && details.open

  // The mascot is one thing, carried between the line it is on while the steps are closed, and the row it sits on in them.
  const stage = useRef<HTMLDivElement>(null)
  const flier = useRef<HTMLDivElement>(null)
  const [home, setHome] = useState<HTMLElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const reduced = useReducedMotion()
  // Its row in the steps is after them all, and stays: it goes down with them as they come, rather than
  // being carried from one to the next, which it would always be behind.
  const place = expanded ? slot ?? home : home
  const [arrivedAt, setArrivedAt] = useState<HTMLElement | null>(null)
  const arrive = useHandler((arrived: boolean) => setArrivedAt(arrived ? place : null))
  // Out to the steps and home again on the quicker spring, so that it is where it is going as they have
  // opened or closed (`.presence-panel` takes as long).
  useFlight(stage, flier, place, !reduced, arrive, true)
  const claim = useCallback((element: HTMLElement) => {
    setSlot(element)
    return () => setSlot((current) => (current === element ? null : current))
  }, [])
  const presence = useMemo<PresenceSlot>(() => ({ claim, arrivedAt }), [claim, arrivedAt])

  // The same function for as long as it is there, so that the mascot, which is memoized, is not drawn
  // again for every render of the chat.
  const toggleDetails = useHandler(() => details?.onToggle())
  // In the text's full colour, which the shimmer dims for all but the band: the subtle colour dimmed again
  // would be too pale to read. Still, with no motion, it is subtle. When the words change, the old fade out and
  // the new in a moment after: they are different words, so the two are not on top of each other for long.
  const text = words && (
    <span className="[--fade-enter:300ms] [--fade-lag:200ms]">
      <ShimmerSwitchText active={working} className="text-kumo-default motion-reduce:text-kumo-subtle">{words}</ShimmerSwitchText>
    </span>
  )

  // The words are gone while the steps are open, and the heading over the steps is what puts them away:
  // focus that was on the words, which opened them, goes to it.
  const heading = useRef<HTMLButtonElement>(null)
  const focusHeading = useRef(false)
  useLayoutEffect(() => {
    if (expanded && focusHeading.current) heading.current?.focus()
    focusHeading.current = false
  }, [expanded])

  const line = (
    <>
      <span ref={setHome} className="block h-8 w-8 shrink-0" />
      {/* Gone the moment the steps open, and back, fading in, only once the mascot is where it goes beside
          them: not while it is still on its way, nor while the steps are still closing. */}
      <span data-hidden={!working || expanded || arrivedAt !== home || undefined} className="presence-label min-w-0 flex-1">{text}</span>
    </>
  )

  return (
    <div ref={stage} inert={!working} className="relative pt-2 text-kumo-subtle">
      {/* What it says, for those who cannot see the line, which is gone while the steps are open. */}
      <span role="status" className="sr-only">{words}</span>
      {/* Played with: a click spins its sparkle (not swelling it brighter than white on an HDR screen, which is
          more than is wanted of something clicked to open the steps). It opens what is behind the status as well, as the status does, and puts it away. Where
          the status goes to writing the reply, it turns to typing dots, and the sparkle's spin out swells
          the same way. Above the steps, which are positioned, and so would be over it. A little smaller
          in the steps, to sit among their marks. */}
      <div ref={flier} data-expanded={expanded || undefined} className="presence-mascot absolute start-0 top-0 z-10 w-8">
        <Mascot emotion={settled?.writing ? 'writing' : 'thinking'} shown={working} interactive onClick={toggleDetails} hdr={false} className="w-8" />
      </div>
      {details
        ? (
          <Collapsible.Root open={expanded} onOpenChange={details.onToggle} className="flex min-w-0 flex-col">
            <div data-away={expanded || undefined} inert={expanded} className="presence-header">
              <div className="min-h-0 overflow-hidden">
                <Collapsible.Trigger
                  onClick={() => {
                    focusHeading.current = true
                  }}
                  className="flex min-h-8 max-w-full cursor-pointer items-center gap-2.5 rounded-full ps-1 pe-2 text-left text-base/5 text-kumo-subtle focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none focus-visible:ring-inset"
                >
                  {line}
                </Collapsible.Trigger>
              </div>
            </div>
            <Collapsible.Panel data-handed-over={(!expanded && details.handedOver) || undefined} className="disclosure-panel presence-panel">
              {/* Says what is open, and closes it. Its words start where the steps' icons do. */}
              <Collapsible.Trigger
                ref={heading}
                className="group ms-1.5 flex min-h-8 w-fit cursor-pointer items-center gap-1.5 rounded-full px-1.5 text-[13px]/5 font-medium text-kumo-subtle hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
              >
                Thinking details
                <ArrowDown01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 transition-transform duration-300 group-data-panel-open:rotate-180 motion-reduce:transition-none" />
              </Collapsible.Trigger>
              <PresenceSlotContext value={presence}>{details.content}</PresenceSlotContext>
            </Collapsible.Panel>
          </Collapsible.Root>
        )
        : <div className="flex min-h-8 items-center gap-2.5 ps-1 pe-2 text-base/5">{line}</div>}
    </div>
  )
}
