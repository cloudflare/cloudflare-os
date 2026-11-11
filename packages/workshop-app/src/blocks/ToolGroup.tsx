import { Badge } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import { WrenchIcon } from '@phosphor-icons/react'
import { Disclosure } from '@/components/Disclosure'
import { ToolStep, type ToolStepEntry } from './ToolStep'

export type ToolGroupProps = {
  /** The run in one line, e.g. "Read 3 files, edited 2, ran code". */
  summary: string
  /** The files and resources the steps touched. */
  targets: string[]
  failed: boolean
  /** A step is still being written or run. */
  running?: boolean
  entries: ToolStepEntry[]
  open: boolean
  onToggle: () => void
  /** The keys of the steps whose detail is showing. */
  openEntries: ReadonlySet<string>
  onToggleEntry: (key: string) => void
}

/**
 * A run of the agent's work collapsed to one line, which opens to its steps. A run of one step is
 * just that step.
 */
export const ToolGroup = ({ summary, targets, failed, running, entries, open, onToggle, openEntries, onToggleEntry }: ToolGroupProps) => {
  const steps = entries.map((entry) => (
    <ToolStep key={entry.key} entry={entry} open={openEntries.has(entry.key)} onToggle={() => onToggleEntry(entry.key)} />
  ))
  if (entries.length === 1) return steps[0]

  return (
    <Disclosure
      open={open}
      onToggle={onToggle}
      summary={
        <>
          <WrenchIcon aria-hidden="true" className="size-5 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span role={running ? 'status' : undefined} className={cn('truncate', running && 'animate-pulse motion-reduce:animate-none')}>
              {summary}
            </span>
            {targets.length > 1 && <span className="truncate font-mono text-xs text-kumo-inactive">{targets.join(' · ')}</span>}
          </span>
          {failed && <Badge variant="error">Error</Badge>}
        </>
      }
    >
      <div className="ms-4 flex flex-col border-s-2 border-kumo-line ps-2">{steps}</div>
    </Disclosure>
  )
}
