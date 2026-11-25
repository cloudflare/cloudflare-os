import { useLayoutEffect, useRef, useState } from 'react'
import { DropdownMenu, useMotionTransition } from '@gadgets/ui'
import { AnimatePresence, motion, type TargetAndTransition } from 'motion/react'
import { AgentIcon } from '@/components/AgentIcon'
import { ArrowRight01Icon } from '@/components/icons'
import { Mascot } from '@/components/mascot/Mascot'
import { sameOrder } from './heldOrder'
import { RunStatusMark } from './RunStatusMark'
import { spaceRing } from './ringSpacing'
import './AgentRunsButton.css'

/** One of the runs the button holds: one that is under way, at work or waiting on the user. */
export type HeldRun = {
  key: string
  title: string
  /** The agent it is a run of, by its name. */
  agent?: string
  status: 'running' | 'waiting'
  /** How it stands, in a word or two: "Running", "Waiting on you". */
  statusWords: string
  /** The run's address, so that it can be opened in another tab. */
  href?: string
}

// What starts a run's item: its agent's cloud while it works, the hand while it waits on the user.
const WorkingMark = ({ className }: { className?: string }) => <AgentIcon weight="fill" className={className} />
const WaitingMark = ({ className }: { className?: string }) => <RunStatusMark status="waiting" className={className} />

export type AgentRunsButtonProps = {
  /** The runs under way, in the order they were started. With none, it goes. */
  runs: readonly HeldRun[]
  /** Opens a run's conversation, by its key. Left out where none can be: its pills are then not pressed. */
  onOpen?: (key: string) => void
  /**
   * Told as it goes while it has the focus, which would otherwise be lost to the page, for it to
   * go where the user carries on (the composer).
   */
  onLeaveFocus?: () => void
}

// How many clouds go round the ring at most: more would crowd a button this size. Past three
// they are drawn smaller (`--fit`), to have room.
const ORBITING = 5
const CROWDED = 3
// How wide the button is (`size-9`), about as large as the composer's own buttons.
const SIZE = 36
const COUNT = new Intl.NumberFormat('en')
const EASE = [0.25, 0.1, 0.25, 1] as const
// A cloud coming into the ring or leaving it, and the others spacing out again meanwhile.
const MARK = { duration: 0.5, ease: EASE }
// The button coming before the composer, or going once the last cloud has left.
const BUTTON = { duration: 0.3, ease: EASE }
const LEAVING = { ...BUTTON, delay: MARK.duration }

// "2 agents: 2 working, 1 waiting on you", or for one alone "An agent working".
const labelOf = (working: number, waiting: number) => {
  if (working + waiting === 1) return working ? 'An agent working' : 'An agent waiting on you'
  const agents = `${COUNT.format(working + waiting)} agents`
  const parts = [working > 0 && `${COUNT.format(working)} working`, waiting > 0 && `${COUNT.format(waiting)} waiting on you`].filter(Boolean)
  return `${agents}: ${parts.join(', ')}`
}

// Where a cloud is spread round the ring, as a share of a turn, and how far it is there: what
// the ring's CSS draws it from, eased by motion as clouds come and go.
const at = (offset: number, presence: number) => ({ '--offset': offset, '--presence': presence }) as TargetAndTransition
// How large the ring's clouds are drawn, smaller where there are many, and how deep it looks, from
// 0 for two to 1 for as many as go round, the far side the smaller and fainter the more there are.
const ring = (count: number) =>
  ({ '--fit': count > CROWDED ? 0.8 : 1, '--depth': Math.min(Math.max((count - 2) / (ORBITING - 2), 0), 1) }) as TargetAndTransition
const ALONE_HIDDEN = { opacity: 0, scale: 0.6 }
// The dot for what waits on the user pops in on a spring that overshoots, and goes quicker than
// it came.
const DOT_IN = { type: 'spring', visualDuration: 0.35, bounce: 0.55 } as const
const DOT_OUT = { duration: 0.15, ease: EASE }
const ALONE_SHOWN = { opacity: 1, scale: 1 }

/**
 * The agents a chat started that are under way, before its composer, where they are seen first: one
 * alone as the mascot, thinking, or alarmed while it waits on the user; more as their clouds going
 * round a ring in depth, the far side smaller and fainter, and a dot is at its foot while any
 * waits on the user. A run that ends
 * fades out of the ring as it goes on turning, the others closing the gap, and one that starts
 * fades in as they make room; the button goes after the last. It opens a menu of them
 * (`DropdownMenu`), an item each, which opens its run.
 */
export const AgentRunsButton = ({ runs, onOpen, onLeaveFocus }: AgentRunsButtonProps) => {
  const [open, setOpen] = useState(false)
  const shown = runs.length > 0
  // Gone with the last run, it is not open when the next one brings it back.
  if (!shown && open) setOpen(false)
  const self = useRef<HTMLDivElement>(null)
  // Before the page takes the focus away from what has gone inert.
  useLayoutEffect(() => {
    if (!shown && self.current?.contains(document.activeElement)) onLeaveFocus?.()
  }, [shown, onLeaveFocus])
  const dotIn = useMotionTransition(DOT_IN)
  const dotOut = useMotionTransition(DOT_OUT)
  const mark = useMotionTransition(MARK)
  const button = useMotionTransition(shown ? BUTTON : LEAVING)
  const working = runs.filter(({ status }) => status === 'running').length
  const waiting = runs.length - working
  // One alone is the mascot, thinking while it works and alarmed while it waits on the user.
  // Otherwise those at work go round first, then those that wait, each in the order started.
  const alone = runs.length === 1 ? runs[0] : undefined
  const orbiting = alone ? [] : runs.toSorted((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running')).slice(0, ORBITING)
  // Where each goes round the ring, kept as they come and go, so that the rest close up or make
  // room from where they are rather than all being placed afresh.
  const keys = orbiting.map(({ key }) => key)
  const [spacing, setSpacing] = useState(() => ({ keys, shares: spaceRing(new Map(), keys) }))
  if (!sameOrder(spacing.keys, keys)) setSpacing({ keys, shares: spaceRing(spacing.shares, keys) })
  const label = shown ? labelOf(working, waiting) : undefined
  // The menu closes with the last run as it was, rather than its item leaving it as it closes.
  const [listed, setListed] = useState(runs)
  if (shown && listed !== runs) setListed(runs)

  // What the button holds: the clouds going round, or the mascot alone, and the dot while one waits.
  const marks = (
    <>
      <motion.span
        aria-hidden="true"
        data-working={working > 0}
        initial={false}
        animate={ring(orbiting.length)}
        transition={mark}
        className="agent-orbit absolute inset-0"
      >
        <AnimatePresence initial={false}>
          {orbiting.map(({ key }) => (
            <motion.span
              key={key}
              className="agent-orbit-mark"
              initial={at(spacing.shares.get(key) ?? 0, 0)}
              animate={at(spacing.shares.get(key) ?? 0, 1)}
              exit={{ '--presence': 0 } as TargetAndTransition}
              transition={mark}
            >
              <AgentIcon weight="fill" className="size-4" />
            </motion.span>
          ))}
        </AnimatePresence>
      </motion.span>
      <AnimatePresence initial={false}>
        {alone && (
          <motion.span
            key="alone"
            aria-hidden="true"
            initial={ALONE_HIDDEN}
            animate={ALONE_SHOWN}
            exit={ALONE_HIDDEN}
            transition={mark}
            className="absolute inset-0 grid place-items-center"
          >
            <Mascot emotion={alone.status === 'running' ? 'thinking' : 'error'} reach={0} hdr={false} className="w-5" />
          </motion.span>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {waiting > 0 && (
          <motion.span
            key="waiting"
            aria-hidden="true"
            initial={{ scale: 0 }}
            animate={{ scale: 1, transition: dotIn }}
            exit={{ scale: 0, opacity: 0, transition: dotOut }}
            className="absolute end-0 bottom-0 size-2 rounded-full bg-kumo-brand ring-3 ring-kumo-base"
          />
        )}
      </AnimatePresence>
    </>
  )

  return (
    <motion.div
      ref={self}
      initial={false}
      animate={shown
        ? { width: SIZE, marginInlineEnd: 8, opacity: 1, scale: 1, visibility: 'visible' }
        : { width: 0, marginInlineEnd: 0, opacity: 0, scale: 0.6, transitionEnd: { visibility: 'hidden' } }}
      transition={button}
      inert={!shown}
      className="flex shrink-0 justify-center"
    >
      {/* The button stays as it is while the menu is open, so that what it says of them stays in sight. */}
      <DropdownMenu
        icon={marks}
        aria-label={label ?? 'Agents'}
        triggerClassName="relative size-9 bg-kumo-elevated"
        side="top"
        keepTrigger
        open={open && shown}
        onOpenChange={setOpen}
      >
        {listed.map((run) => (
          <DropdownMenu.Item
            key={run.key}
            icon={run.status === 'running' ? WorkingMark : WaitingMark}
            label={run.title}
            disabled={!onOpen}
            onSelect={() => onOpen?.(run.key)}
          >
            {/* The agent's name, a chevron and the run's title, as the run's header has them. */}
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {run.agent && (
                <>
                  <span className="max-w-40 shrink-0 truncate text-kumo-subtle">{run.agent}</span>
                  <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
                  <span className="sr-only">, </span>
                </>
              )}
              <span className="min-w-0 truncate">{run.title}</span>
              <span className="sr-only">, {run.statusWords}</span>
            </span>
            {run.status === 'running' && <RunStatusMark status="running" className="size-4" />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu>
    </motion.div>
  )
}
