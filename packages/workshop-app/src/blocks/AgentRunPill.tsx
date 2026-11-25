import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, type LinkButtonProps } from '@gadgets/ui'
import { AgentMark } from './AgentMark'
import { RUN_STATUS_WORDS_COLOUR, RunStatusMark, type AgentRunStatus } from './RunStatusMark'

export type AgentRunPillProps = Omit<LinkButtonProps, 'onClick' | 'children'> & {
  /** Told of the click too, before it opens the run: for a menu whose item it is. */
  onClick?: LinkButtonProps['onClick']
  /** The run's title: what it was started to do. */
  title: string
  /** How it stands, as a mark at its end. Left out where only that it started is said. */
  status?: AgentRunStatus
  /** How it stands in words, after the title: "Finished", "Failed". Read out either way. */
  statusWords?: string
  /** Opens the run's conversation. */
  onOpen: () => void
}

/**
 * One agent's run as a pill: the agent's cloud, what it was started to do, and how it stands where
 * that is said. It opens the run's conversation. Whatever it is given beyond that goes to its
 * button, so that a menu can draw its items as these.
 */
export const AgentRunPill = ({ title, status, statusWords, onOpen, onClick, className, ...props }: AgentRunPillProps) => (
  <LinkButton
    {...props}
    onClick={(event) => {
      onClick?.(event)
      onOpen()
    }}
    className={cn(
      'inline-flex h-10 max-w-full min-w-0 items-center gap-2.5 rounded-full bg-kumo-base px-3 text-left text-base text-kumo-default ring-1 ring-kumo-line outline-none',
      'hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring data-highlighted:bg-kumo-tint',
      className,
    )}
  >
    <AgentMark size="small" state={status === 'running' ? 'working' : status === 'failed' ? 'failed' : 'idle'} />
    <span className="min-w-0 truncate">{title}</span>
    {statusWords && (
      <span className={cn('shrink-0', status ? RUN_STATUS_WORDS_COLOUR[status] : 'text-kumo-subtle')}>{statusWords}</span>
    )}
    {status && <RunStatusMark status={status} className="size-4" />}
  </LinkButton>
)
