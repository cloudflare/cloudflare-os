import { isUnderWay, ToolStep, type ToolStepEntry } from './ToolStep'

export type WorkLogProps = {
  /** The steps so far, oldest first. The last may be what is happening right now. */
  steps: ToolStepEntry[]
  /** The keys of the steps whose detail is showing. */
  openSteps: ReadonlySet<string>
  onToggleStep: (key: string) => void
}

/**
 * How a reply is coming about: the steps taken since the last message, each opening to what it
 * did. What is happening right now is last and shown open: the code being run, the thinking, the
 * reply being drafted.
 */
export const WorkLog = ({ steps, openSteps, onToggleStep }: WorkLogProps) => {
  const last = steps.at(-1)
  const now = last && isUnderWay(last) ? last.key : undefined

  return (
    <div className="flex flex-col">
      {steps.map((step) => (
        <ToolStep key={step.key} entry={step} open={step.key === now || openSteps.has(step.key)} onToggle={() => onToggleStep(step.key)} />
      ))}
      {steps.length === 0 && <p className="px-2 py-1 text-sm text-kumo-inactive">Nothing to show yet.</p>}
    </div>
  )
}
