import { useEffect, useRef, useState } from 'react'
import { AgentMark } from '../../../components/icons/brandMarks'
import { ChevronRightIcon } from '../../../components/icons/designIcons'
import { formatWorkedFor, type TurnWork } from './turnWork'
import styles from './transcript.module.css'

/** What the agent is doing, as the status line says it. */
export type AgentStatus = {
  /**
   * The step in plain words; null while it writes its answer, when the mark alone shows; and
   * undefined when nothing new can be said, so the line keeps saying what it last said rather
   * than flickering through every pause between steps.
   */
  label: string | null | undefined
  /** The agent is paused on the person, so the words hold still instead of shimmering. */
  waiting?: boolean
}

/** A finished turn's work, and whether its steps are open. */
export type FinishedWork = { work: TurnWork; expanded: boolean; onToggle: () => void }

const THINKING = 'Thinking...'

// A step stays up at least this long, so quick steps read as progress rather than flicker.
const MIN_STEP_MS = 1200

/** `value`, changing no sooner than `minMs` after it last changed, unless `now`. */
function useSteady<T>(value: T, minMs: number, now: boolean): T {
  const [shown, setShown] = useState(value)
  const since = useRef(0)
  useEffect(() => {
    if (Object.is(value, shown)) return
    const wait = now ? 0 : minMs - (performance.now() - since.current)
    const timer = setTimeout(() => {
      since.current = performance.now()
      setShown(value)
    }, Math.max(0, wait))
    return () => clearTimeout(timer)
  }, [value, shown, minMs, now])
  return shown
}

/**
 * The agent at work (Figma "Frame 799"): its mark beside a shimmering line saying what it is
 * doing, in words anyone can follow. It stays in one place under the conversation for the whole
 * turn, opening and closing by its height so nothing above it moves, and passes from one step to
 * the next with the old words lifting away as the new ones rise in.
 *
 * It sits under the message that started its turn, above the agent's reply. When the turn ends
 * having done some work, it settles where it is into how long that took ("Worked for 42s"),
 * which opens to its steps; with none, it closes. Earlier turns keep the line, drawn `still`.
 */
export function AgentStatusLine({ status, done, still = false }: {
  status: AgentStatus | null
  done?: FinishedWork
  /** Drawn as history: no motion on arrival. */
  still?: boolean
}) {
  const finished = status === null ? done : undefined
  // A line that starts with its turn opens from nothing on the frame after it mounts; one drawn
  // with history is simply there.
  const [ready, setReady] = useState(still || status === null)
  useEffect(() => {
    if (ready) return
    const frame = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(frame)
  }, [ready])
  const open = ready && (status !== null || finished !== undefined)

  // What the line says: the newest thing worth saying this turn. After the answer was being
  // written, a pause means the agent is thinking again, not still writing.
  const said = useRef<{ label: string | null; waiting: boolean }>({ label: THINKING, waiting: false })
  if (finished) said.current = { label: formatWorkedFor(finished.work.seconds), waiting: true }
  else if (!open) said.current = { label: THINKING, waiting: false }
  else if (status!.label !== undefined) said.current = { label: status!.label, waiting: status!.waiting === true }
  else if (said.current.label === null) said.current = { label: THINKING, waiting: false }

  const label = useSteady(said.current.label, MIN_STEP_MS, finished !== undefined || still)
  const quiet = said.current.waiting && label === said.current.label

  // The words just replaced, drawn leaving until the next change.
  const [leaving, setLeaving] = useState<{ label: string; key: number } | null>(null)
  const previous = useRef(label)
  const changes = useRef(0)
  useEffect(() => {
    if (previous.current !== label && previous.current !== null && open && !still) {
      setLeaving({ label: previous.current, key: ++changes.current })
    }
    previous.current = label
  }, [label, open, still])

  const settled = finished !== undefined && label === said.current.label
  const expandable = settled && finished.work.steps.length > 0
  const expanded = expandable && finished.expanded

  const row = (
    <>
      <AgentMark
        size={24}
        className={`${styles.mark} -my-0.5 -ml-0.5 shrink-0 ${settled ? 'text-kumo-inactive' : 'text-kumo-default'} ${label === null && open ? styles.breathing : ''}`}
      />
      <span className="relative">
        {leaving && (
          <span
            key={leaving.key}
            aria-hidden="true"
            className={`${styles.statusLabelOut} text-kumo-subtle`}
            onAnimationEnd={() => setLeaving(null)}
          >
            {leaving.label}
          </span>
        )}
        {label === null ? (
          <span className="sr-only">Writing</span>
        ) : (
          <span
            key={label}
            className={`whitespace-nowrap ${still ? '' : styles.statusLabel} ${settled ? '' : quiet ? 'text-kumo-subtle' : styles.shimmer}`}
          >
            {label}
          </span>
        )}
      </span>
      {expandable && (
        <ChevronRightIcon
          size={14}
          className={`-ml-1 shrink-0 text-kumo-subtle opacity-60 transition-transform duration-200 ease-out ${expanded ? 'rotate-90' : ''}`}
        />
      )}
    </>
  )
  const rowClass = 'flex h-8 w-fit items-center gap-[9px] rounded-lg p-1.5 text-[14px] leading-5'

  return (
    <div className={styles.statusLine} data-open={open} data-testid="agent-status">
      <div className="min-h-0 overflow-hidden">
        <div className="pt-2.5">
          {expandable ? (
            <button
              type="button"
              onClick={finished.onToggle}
              aria-expanded={expanded}
              className={`${rowClass} cursor-pointer text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring`}
            >
              {row}
            </button>
          ) : (
            <div role="status" aria-live={still ? undefined : 'polite'} className={`${rowClass} text-kumo-default`}>
              {row}
            </div>
          )}
          {finished && finished.work.steps.length > 0 && (
            <div className={styles.steps} data-open={expanded}>
              <div className="min-h-0 overflow-hidden">
                <ol className="ml-[17px] border-l border-kumo-line pb-1 pl-[19px] pt-0.5" aria-label="Steps">
                  {finished.work.steps.map((step, index) => (
                    <li key={index} className={`${styles.step} relative py-[3px] text-[13px] leading-[18px] text-kumo-subtle`}>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
