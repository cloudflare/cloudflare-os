import { isUnderWay, ToolStep, type ToolStepEntry } from './ToolStep'

export type WorkLogProps = {
  /** The steps so far, oldest first. The last may be what is happening right now. */
  steps: ToolStepEntry[]
  /** The keys of the steps that were switched from how they start out: closed, or open for a lone step. */
  openSteps: ReadonlySet<string>
  onToggleStep: (key: string) => void
}

/**
 * How a reply is coming about, or came about: the steps taken since the message before, each
 * opening to what it did. What is happening right now is last and shown open: the code being run,
 * the thinking, the reply being drafted. A step that is the only one starts out open too: there
 * is nothing else to look at, so having to open it would only be in the way.
 */
export const WorkLog = ({ steps, openSteps, onToggleStep }: WorkLogProps) => {
  const last = steps.at(-1)
  const now = last && isUnderWay(last) ? last.key : undefined
  const alone = steps.length === 1
  // `openSteps` holds the steps someone switched. For a step that starts out closed that means
  // opened, and for the lone one, which starts out open, it means closed.
  const isOpen = (key: string) => key === now || openSteps.has(key) !== alone

  return (
    <div className="flex flex-col">
      {steps.map((step) => (
        <ToolStep key={step.key} entry={step} open={isOpen(step.key)} onToggle={() => onToggleStep(step.key)} />
      ))}
      {steps.length === 0 && <p className="px-2 py-1 text-sm text-kumo-inactive">Nothing to show yet.</p>}
    </div>
  )
}
