import type { CSSProperties } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { cn } from '@cloudflare/kumo/utils'
import { AgentMark } from './AgentMark'
import { AgentRunPill } from './AgentRunPill'
import type { AgentRunStatus } from './RunStatusMark'
import './AgentRunsButton.css'

/** One of the runs the button holds. */
export type HeldRun = {
  key: string
  title: string
  status: AgentRunStatus
  /** How it stands, in a word or two: "Running", "Waiting on you". */
  statusWords: string
  /** The run's address, so that it can be opened in another tab. */
  href?: string
}

export type AgentRunsButtonProps = {
  /** The runs to show, in the order they were started. Nothing is drawn for none. */
  runs: readonly HeldRun[]
  /** Opens a run's conversation, by its key. */
  onOpen: (key: string) => void
  /** Told when the list is put away: whatever had finished in it has been seen. */
  onSeen?: () => void
}

// How many clouds go round the ring at most: more would crowd a button this size.
const ORBITING = 3
const ENDED: ReadonlySet<AgentRunStatus> = new Set(['done', 'changes', 'failed'])
const COUNT = new Intl.NumberFormat('en')

// The clouds that go round: those at work first, then what waits on the user, then the rest.
const RANK: Record<AgentRunStatus, number> = { running: 0, waiting: 1, failed: 2, changes: 3, done: 4 }

// "3 agents, 1 finished, 1 waiting on you".
const labelOf = (count: number, ended: number, waiting: number) => {
  const agents = count === 1 ? 'An agent' : `${COUNT.format(count)} agents`
  const standing = ended === count ? ' finished' : ended > 0 ? `, ${COUNT.format(ended)} finished` : ' working'
  const asks = waiting > 0 ? `, ${COUNT.format(waiting)} waiting on you` : ''
  return agents + standing + asks
}

/**
 * The agents a chat started that are still to be seen to, beside its composer: their clouds going
 * round a ring while any works, in depth, the ring around the button filling as they finish, and a
 * dot while any waits on the user. It opens to a pill for each, which opens its run, and is put
 * away as a menu is.
 */
export const AgentRunsButton = ({ runs, onOpen, onSeen }: AgentRunsButtonProps) => {
  if (runs.length === 0) return null
  const ended = runs.filter(({ status }) => ENDED.has(status)).length
  const waiting = runs.filter(({ status }) => status === 'waiting').length
  const working = runs.some(({ status }) => status === 'running')
  const orbiting = runs.toSorted((a, b) => RANK[a.status] - RANK[b.status]).slice(0, ORBITING)
  const label = labelOf(runs.length, ended, waiting)

  return (
    <Menu.Root onOpenChange={(open) => !open && onSeen?.()}>
      <Menu.Trigger
        aria-label={label}
        title={label}
        className="relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-kumo-elevated ring-1 ring-kumo-line outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring data-popup-open:bg-kumo-tint"
      >
        <span aria-hidden="true" data-working={working} data-alone={orbiting.length === 1} className="agent-orbit absolute inset-0" style={{ '--n': orbiting.length } as CSSProperties}>
          {orbiting.map((run, index) => (
            <span key={run.key} className="agent-orbit-mark" style={{ '--i': index } as CSSProperties}>
              <AgentMark size="small" state={run.status === 'running' ? 'working' : run.status === 'failed' ? 'failed' : 'idle'} />
            </span>
          ))}
        </span>
        {/* How many have finished, as the ring around the button. */}
        <svg aria-hidden="true" viewBox="0 0 44 44" className="pointer-events-none absolute inset-0 -rotate-90 text-kumo-default">
          <circle
            cx="22"
            cy="22"
            r="21"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={`${ended / runs.length} 1`}
            className={cn('transition-[stroke-dasharray] duration-500 motion-reduce:transition-none', ended === 0 && 'opacity-0')}
          />
        </svg>
        {waiting > 0 && <span aria-hidden="true" className="absolute end-0.5 top-0.5 size-2.5 rounded-full bg-kumo-warning ring-2 ring-kumo-base" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={2} alignOffset={-8} collisionPadding={12} className="z-50">
          <Menu.Popup
            aria-label="Agents"
            className={cn(
              // Padded, so that what scrolls does not cut the pills' rings and shadows off.
              'flex max-h-(--available-height) max-w-[min(var(--available-width),24rem)] flex-col items-end gap-1.5 overflow-y-auto p-2 outline-none',
              'origin-(--transform-origin) transition-[opacity,translate] duration-200 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0 motion-reduce:transition-none',
            )}
          >
            {runs.map((run) => (
              <Menu.Item
                key={run.key}
                label={run.title}
                // A pill is a link where the run has an address, and a button where it has none.
                nativeButton={run.href === undefined}
                render={(props) => (
                  <AgentRunPill
                    {...props}
                    href={run.href}
                    title={run.title}
                    status={run.status}
                    aria-label={`${run.title}: ${run.statusWords}`}
                    onOpen={() => onOpen(run.key)}
                    // Over the conversation, so lifted off it.
                    className="bg-kumo-elevated shadow-lg"
                  />
                )}
              />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
