import { useRef } from 'react'
import { MascotSlot, usePresenceSlot } from './presenceSlot'
import { ToolStep, type ToolStepEntry } from './ToolStep'

export type WorkLogProps = {
  /** The steps so far, oldest first. The last may be what is happening right now. */
  steps: ToolStepEntry[]
  /** The keys of the steps opened or put away by hand: the others are as `startOpen` has them. */
  toggledSteps: ReadonlySet<string>
  onToggleStep: (key: string) => void
  /**
   * Every step that has something to show starts open: for what is being watched as it happens, and what
   * was, rather than what is looked back on, whose steps start as one line each.
   */
  startOpen?: boolean
  /**
   * The steps before these are shown above, in the conversation (among the pills of the agents the
   * chat started): with none of its own, the mascot does not say that it waits for the agent.
   */
  continues?: boolean
}

/**
 * How a reply is coming about, or came about: the steps taken since the message before, each
 * opening to what it did. Inside the assistant's presence the mascot is the last row, after them all, saying
 * it waits for the agent until there are steps, and alone after; the steps come in above it, and it goes
 * down with them. Above a message it is the history that led up to it, with the same rows.
 */
export const WorkLog = ({ steps, toggledSteps, onToggleStep, startOpen = false, continues = false }: WorkLogProps) => {
  // The steps there were when it was first shown: the ones after come in, as they are made, and these are simply there.
  const first = useRef(new Set(steps.map((step) => step.key)))
  const withMascot = !!usePresenceSlot()

  return (
    <div className="flex flex-col">
      {steps.map((step) => (
        <ToolStep key={step.key} entry={step} open={toggledSteps.has(step.key) !== startOpen} onToggle={() => onToggleStep(step.key)} fresh={!first.current.has(step.key)} />
      ))}
      {/* The mascot alone once there are steps, which say what it is doing. Before there are, it says it waits, or
          the steps would be nothing but it; its words waiting for it to be there as the steps open. */}
      {withMascot && (
        <div className="group flex min-h-10 items-center gap-2 px-1.5 text-[13px]/5">
          <MascotSlot holdUntilArrived />
          {steps.length === 0 && !continues && (
            <span className="min-w-0 truncate text-kumo-default transition-opacity duration-500 group-has-data-waiting:opacity-0 group-has-data-waiting:transition-none motion-reduce:transition-none">
              Waiting for the agent…
            </span>
          )}
        </div>
      )}
      {steps.length === 0 && !withMascot && <p className="min-h-10 ps-10.5 text-[13px]/10 text-kumo-inactive">Nothing to show yet.</p>}
    </div>
  )
}
