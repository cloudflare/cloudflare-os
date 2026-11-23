import { useEffect, useRef } from 'react'
import { MascotSlot, usePresenceSlot } from './presenceSlot'
import { isUnderWay, ToolStep, type ToolStepEntry } from './ToolStep'

export type WorkLogProps = {
  /** The steps so far, oldest first. The last may be what is happening right now. */
  steps: ToolStepEntry[]
  /** The keys of the steps whose detail is showing. */
  openSteps: ReadonlySet<string>
  onToggleStep: (key: string) => void
  /**
   * Opening the step that is under way means to keep whichever is under way open, as the agent goes
   * on, and closing it means to stop. Without it, that step is like any other.
   */
  follow?: { on: boolean; onChange: (on: boolean) => void }
}

/**
 * How a reply is coming about, or came about: the steps taken since the message before, each
 * opening to what it did. Nothing opens by itself: a step is closed until someone opens it, but for
 * the one under way while it is being followed. Inside the assistant's presence the mascot is the last
 * row: at the step that is under way, or on a row of its own when none is. Above a message it is the
 * history that led up to it, with the same rows.
 */
export const WorkLog = ({ steps, openSteps, onToggleStep, follow }: WorkLogProps) => {
  const last = steps.at(-1)
  const now = last && isUnderWay(last) ? last.key : undefined
  // The steps there were when it was first shown: the ones after come in, as they are made, and these are simply there.
  const first = useRef(new Set(steps.map((step) => step.key)))
  // A step is open when someone opened it, except the step under way while it is being followed: it is open for as
  // long as it is under way, and the next one is open in its place, rather than the ones it was open for staying so.
  const isOpen = (key: string) => openSteps.has(key) || (!!follow?.on && key === now)
  // Inside the assistant's presence the mascot is the last row: at the step that is under way, or on
  // a row of its own when none is.
  const presence = usePresenceSlot()
  const withMascot = !!presence
  // The bare row the mascot has between steps is made room for as it comes (see below), and what takes its place
  // is not made room for again: the room is already there, and the row of the step that came would
  // open from nothing as that one went, which the conversation's scroll would follow down and up.
  const trailing = withMascot && now === undefined
  const hadTrailing = useRef(false)
  useEffect(() => {
    hadTrailing.current = trailing
  })
  // Decided once for each step, as it is first drawn: it is when it is drawn that it comes in.
  const enters = useRef(new Map<string, boolean>())
  const enter = (key: string) => {
    if (!enters.current.has(key)) enters.current.set(key, !first.current.has(key) && !hadTrailing.current)
    return enters.current.get(key)
  }
  const toggle = (key: string) => {
    if (!follow || key !== now) return onToggleStep(key)
    const open = isOpen(key)
    follow.onChange(!open)
    // Opened by hand before it was under way, it has to be put away too, or it would stay open.
    if (open && openSteps.has(key)) onToggleStep(key)
  }

  return (
    <div className="flex flex-col">
      {steps.map((step) => (
        <ToolStep key={step.key} entry={step} open={isOpen(step.key)} onToggle={() => toggle(step.key)} fresh={!first.current.has(step.key)} enter={enter(step.key)} mascot={withMascot && step.key === now} />
      ))}
      {trailing && (
        <div className="row-enter flex min-h-10 items-center px-1.5">
          <MascotSlot />
        </div>
      )}
      {steps.length === 0 && !withMascot && <p className="min-h-10 ps-10.5 text-[13px]/10 text-kumo-inactive">Nothing to show yet.</p>}
    </div>
  )
}
