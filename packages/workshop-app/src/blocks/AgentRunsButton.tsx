import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { useMotionTransition } from '@gadgets/ui'
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from 'motion/react'
import { AgentIcon } from '@/components/AgentIcon'
import { Mascot } from '@/components/mascot/Mascot'
import { AgentRunPill } from './AgentRunPill'
import { sameOrder } from './heldOrder'
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
// The room round the list for its pills' shadows to fade out in: its padding (`p-11`) and half the
// gap between two pills (`py-1` each).
const SHADOW_ROOM = 48
// How far over the button the list is, and how far in from the window's edges.
const OVER_BUTTON = 10
const FROM_EDGES = 12

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
// A pill joining the list while it is open, or leaving it as its run ends: its room opens or
// closes, the others moving up or down to make it or take it, as it grows or shrinks in place.
// Only its height is opened and closed, the gap round it (`py-1`) inside, so that it closes to nothing.
const ITEM_AWAY = { height: 0, opacity: 0, scale: 0.8 }
const ITEM_HERE = { height: 'auto', opacity: 1, scale: 1 }

// A pill of the list, which is not pressed or pointed at once it is leaving.
const ListedRun = ({ transition, children }: { transition: ReturnType<typeof useMotionTransition>; children: (leaving: boolean) => ReactNode }) => {
  const leaving = !useIsPresent()
  return (
    <motion.div
      initial={ITEM_AWAY}
      animate={ITEM_HERE}
      exit={ITEM_AWAY}
      transition={transition}
      className="flex max-w-full origin-left"
    >
      <div className="flex max-w-full py-1">{children(leaving)}</div>
    </motion.div>
  )
}

/**
 * The agents a chat started that are under way, before its composer, where they are seen first: one
 * alone as the mascot, thinking, or alarmed while it waits on the user; more as their clouds going
 * round a ring in depth, the far side smaller and fainter, and a dot is at its foot while any
 * waits on the user. A run that ends
 * fades out of the ring as it goes on turning, the others closing the gap, and one that starts
 * fades in as they make room; the button goes after the last. It opens to a pill for each, which
 * opens its run, and which folds away there as its run ends.
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
  // The list closes with the last run as it was, rather than its pill leaving it as it closes.
  const [listed, setListed] = useState(runs)
  if (shown && listed !== runs) setListed(runs)

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
      <Menu.Root open={open && shown} onOpenChange={setOpen}>
        <Menu.Trigger
          aria-label={label}
          title={label}
          className="relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-kumo-elevated text-kumo-default ring-1 ring-kumo-line outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring data-popup-open:bg-kumo-tint"
        >
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
        </Menu.Trigger>
        <Menu.Portal>
          {/* Its padding is where the pills' shadows fade out, so it is set back by as much. That
              reaches over the button, so nothing but the pills is pressed: the button is, again,
              to put it away. */}
          <Menu.Positioner side="top" align="start" sideOffset={OVER_BUTTON - SHADOW_ROOM} alignOffset={-SHADOW_ROOM} collisionPadding={FROM_EDGES - SHADOW_ROOM} className="pointer-events-none z-50">
            <Menu.Popup
              aria-label="Agents"
              className={[
                // Padded, so that what scrolls does not cut the pills' shadows off; only the pills
                // are pressed, so the padding over the button and the conversation is not there.
                'agent-runs-menu pointer-events-none flex max-h-(--available-height) max-w-[min(var(--available-width),36rem)] flex-col items-start overflow-y-auto p-11 outline-none',
              ].join(' ')}
            >
              <AnimatePresence initial={false}>
                {listed.map((run, index) => (
                  <ListedRun key={run.key} transition={mark}>
                    {(leaving) => (
                      <Menu.Item
                        label={run.title}
                        disabled={!onOpen || leaving}
                        // A pill is a link where the run has an address, and a button where it has none.
                        nativeButton={onOpen !== undefined && run.href === undefined}
                        render={(props) => (
                          <AgentRunPill
                            {...props}
                            href={run.href}
                            title={run.title}
                            agent={run.agent}
                            status={run.status}
                            statusWords={run.statusWords}
                            onOpen={onOpen && (() => onOpen(run.key))}
                            style={{ '--from-button': listed.length - index } as CSSProperties}
                            // Over the conversation, lifted off it as glass is: by a shadow all round it,
                            // faint and blurred far out, from no side, which its ring stays inside of.
                            className={`agent-runs-pill ${leaving ? 'pointer-events-none' : 'pointer-events-auto'} bg-kumo-elevated shadow-[0_0_2px_rgb(0_0_0/0.04),0_0_16px_rgb(0_0_0/0.05),0_0_48px_rgb(0_0_0/0.1)]`}
                          />
                        )}
                      />
                    )}
                  </ListedRun>
                ))}
              </AnimatePresence>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </motion.div>
  )
}
