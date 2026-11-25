import { useState, type CSSProperties } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { useMotionTransition } from '@gadgets/ui'
import { AnimatePresence, motion, type TargetAndTransition } from 'motion/react'
import { AgentIcon } from '@/components/AgentIcon'
import { AgentRunPill } from './AgentRunPill'
import type { AgentRunStatus } from './RunStatusMark'
import './AgentRunsButton.css'

/** One of the runs the button holds: one that is under way, at work or waiting on the user. */
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
  /** The runs under way, in the order they were started. With none, it goes. */
  runs: readonly HeldRun[]
  /** Opens a run's conversation, by its key. */
  onOpen: (key: string) => void
}

// How many clouds go round the ring at most: more would crowd a button this size.
const ORBITING = 3
const COUNT = new Intl.NumberFormat('en')
const EASE = [0.25, 0.1, 0.25, 1] as const
// A cloud coming into the ring or leaving it, and the others spacing out again meanwhile.
const MARK = { duration: 0.5, ease: EASE }
// The button coming beside the composer, or going once the last cloud has left.
const BUTTON = { duration: 0.3, ease: EASE }
const LEAVING = { ...BUTTON, delay: MARK.duration }

// "2 agents working, 1 waiting on you".
const labelOf = (working: number, waiting: number) => {
  const agents = working + waiting === 1 ? 'An agent' : `${COUNT.format(working + waiting)} agents`
  const parts = [working > 0 && `${COUNT.format(working)} working`, waiting > 0 && `${COUNT.format(waiting)} waiting on you`].filter(Boolean)
  return `${agents}: ${parts.join(', ')}`
}

// Where a cloud is spread round the ring, as a share of a turn, and how far it is there: what
// the ring's CSS draws it from, eased by motion as clouds come and go.
const at = (offset: number, presence: number) => ({ '--offset': offset, '--presence': presence }) as TargetAndTransition

/**
 * The agents a chat started that are under way, beside its composer: their clouds going round a
 * ring in depth, the far side smaller, fainter and out of focus, while a light sweeps across the
 * button for as long as any works, and a dot while any waits on the user. A run that ends leaves
 * the ring as it goes round, the others spacing out again, and the button goes after the last.
 * It opens to a pill for each, which opens its run.
 */
export const AgentRunsButton = ({ runs, onOpen }: AgentRunsButtonProps) => {
  const [open, setOpen] = useState(false)
  const shown = runs.length > 0
  const mark = useMotionTransition(MARK)
  const button = useMotionTransition(shown ? BUTTON : LEAVING)
  const working = runs.filter(({ status }) => status === 'running').length
  const waiting = runs.length - working
  // Those at work go round first, then those that wait, each in the order they were started.
  const orbiting = runs.toSorted((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running')).slice(0, ORBITING)
  const label = shown ? labelOf(working, waiting) : undefined

  return (
    <motion.div
      initial={false}
      animate={shown
        ? { width: 44, marginInlineStart: 8, opacity: 1, scale: 1, visibility: 'visible' }
        : { width: 0, marginInlineStart: 0, opacity: 0, scale: 0.6, transitionEnd: { visibility: 'hidden' } }}
      transition={button}
      inert={!shown}
      className="flex shrink-0 justify-center"
    >
      <Menu.Root open={open && shown} onOpenChange={setOpen}>
        <Menu.Trigger
          aria-label={label}
          title={label}
          className="relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-kumo-elevated text-kumo-default ring-1 ring-kumo-line outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring data-popup-open:bg-kumo-tint"
        >
          <span aria-hidden="true" data-active={working > 0} className="agent-runs-shimmer" />
          <motion.span
            aria-hidden="true"
            data-working={working > 0}
            initial={false}
            animate={{ '--spread': orbiting.length > 1 ? 1 : 0 } as TargetAndTransition}
            transition={mark}
            className="agent-orbit absolute inset-0"
            style={{ '--spread': orbiting.length > 1 ? 1 : 0 } as CSSProperties}
          >
            <AnimatePresence initial={false}>
              {orbiting.map((run, index) => (
                <motion.span
                  key={run.key}
                  className="agent-orbit-mark"
                  initial={at(index / orbiting.length, 0)}
                  animate={at(index / orbiting.length, 1)}
                  exit={{ '--presence': 0 } as TargetAndTransition}
                  transition={mark}
                >
                  <AgentIcon weight="fill" className="size-4.5" />
                </motion.span>
              ))}
            </AnimatePresence>
          </motion.span>
          {waiting > 0 && <span aria-hidden="true" className="absolute end-0.5 top-0.5 size-2.5 rounded-full bg-kumo-warning ring-2 ring-kumo-base" />}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={2} alignOffset={-8} collisionPadding={12} className="z-50">
            <Menu.Popup
              aria-label="Agents"
              className={[
                // Padded, so that what scrolls does not cut the pills' rings and shadows off.
                'flex max-h-(--available-height) max-w-[min(var(--available-width),24rem)] flex-col items-end gap-1.5 overflow-y-auto p-2 outline-none',
                'origin-(--transform-origin) transition-[opacity,translate] duration-200 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0 motion-reduce:transition-none',
              ].join(' ')}
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
    </motion.div>
  )
}
