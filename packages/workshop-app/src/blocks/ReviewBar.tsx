import { useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretLeftIcon, CaretRightIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ActionFields, type ActionField } from './ActionFields'
import { usePending, type ActionResult } from './usePending'

/** One change waiting on the file, as the bar names it. */
export type ReviewChange = {
  actionId: number
  title: string
  /** The gatekeeper's own account of it, as Markdown, and what it sends. */
  description: string
  fields: ActionField[]
}

export type ReviewBarProps = {
  /** In the order they are drawn on the file. */
  changes: ReviewChange[]
  /** The one stepped to, outlined on the file. */
  focusedId: number
  onFocus: (actionId: number) => void
  onApprove: (actionId: number) => ActionResult
  onDeny: (actionId: number) => ActionResult
  onApproveAll: () => ActionResult
  onDenyAll: () => ActionResult
  /** Read in full before approving: see `PendingTray`. */
  restricted?: boolean
  progress?: { verb: 'Approving' | 'Denying'; done: number; total: number }
  problem?: string
  onDismissProblem?: () => void
  /**
   * The file is not made yet, and one of `changes` makes it: they are decided whole, with Create,
   * which approves them all, or Discard.
   */
  creates?: { title: string; kind: 'document' | 'spreadsheet' | 'presentation' }
}

const NOUN = { document: 'document', spreadsheet: 'spreadsheet', presentation: 'presentation' } as const

const EASE = [0.25, 0.1, 0.25, 1] as const

const flat = (text: string) => text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()

/** What a change does, in a line: its first field, or its description. */
export const changeLine = ({ description, fields }: Pick<ReviewChange, 'description' | 'fields'>) => {
  const first = fields[0]
  const value = first && 'value' in first ? String(first.value) : first && 'items' in first ? first.items.join(', ') : undefined
  return flat(first && value !== undefined ? `${first.label}: ${value}` : description)
}

const STEP = 'grid size-8 place-items-center rounded-full text-kumo-subtle outline-none not-disabled:hover:bg-kumo-tint not-disabled:hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-35'

/**
 * Reviewing a file's waiting changes on the file itself: floated over its foot, it names the change
 * stepped to (which the file outlines and scrolls to), steps through them in the order they are
 * drawn, and decides that one, or all of them. Clicking a change on the file steps to it. In a
 * workspace that has read sensitive data the change is shown in full, and only it can be approved.
 */
export const ReviewBar = ({
  changes, focusedId, onFocus, onApprove, onDeny, onApproveAll, onDenyAll, restricted, progress, problem, onDismissProblem, creates,
}: ReviewBarProps) => {
  const reduced = useReducedMotion()
  const transition = reduced ? { duration: 0 } : { duration: 0.2, ease: EASE }
  const [pending, run] = usePending()
  const [confirming, setConfirming] = useState(false)
  const id = useId()
  const index = Math.max(0, changes.findIndex(({ actionId }) => actionId === focusedId))
  const current = changes[index]
  const busy = pending || progress !== undefined
  const many = changes.length > 1
  if (!current) return null

  return (
    <motion.section
      aria-label="Review changes"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={transition}
      className="@container pointer-events-auto mx-auto w-full max-w-[36rem] overflow-hidden rounded-[21px] bg-kumo-base ring-1 ring-kumo-line shadow-[0_8px_24px_rgb(0_0_0/0.08)]"
    >
      <AnimatePresence initial={false}>
        {problem && (
          <motion.p
            key="problem"
            role="alert"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="flex items-start gap-2 overflow-hidden bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-default"
          >
            <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0 text-kumo-danger" />
            <span className="min-w-0 flex-1">{problem}</span>
            {onDismissProblem && <button type="button" className="shrink-0 font-medium hover:underline" onClick={onDismissProblem}>Dismiss</button>}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Too narrow for all of it on a line, as on a phone, the change has its own line above the controls. */}
      {creates ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 ps-4 pe-2">
          <span className="min-w-0 flex-1 @max-md:basis-full">
            <span className="flex items-center gap-1.5">
              <span id={`${id}-title`} className="truncate text-base/5 font-medium text-kumo-default">{creates.title}</span>
              <span className="shrink-0 rounded-md bg-kumo-tint px-1.5 text-xs/4 font-medium text-kumo-subtle">New</span>
            </span>
            <span className="block truncate text-sm text-kumo-subtle">
              {progress ? `${progress.verb} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : 'Not created yet'}
            </span>
          </span>
          {confirming ? (
            <span role="alert" className="ms-auto flex items-center gap-1">
              <span className="px-1 text-sm text-kumo-default">Discard this {NOUN[creates.kind]}?</span>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
              <Button variant="danger" onClick={() => { setConfirming(false); run(onDenyAll) }}>Discard</Button>
            </span>
          ) : (
            <span className="ms-auto flex shrink-0 items-center gap-1">
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>Discard</Button>
              {!restricted && <Button variant="primary" disabled={busy} aria-describedby={`${id}-title`} onClick={() => run(onApproveAll)}>Create {NOUN[creates.kind]}</Button>}
            </span>
          )}
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-1 p-2">
        {many && (
          <div className="flex shrink-0 items-center">
            <button type="button" aria-label="Previous change" className={STEP} disabled={index === 0} onClick={() => onFocus(changes[index - 1].actionId)}>
              <CaretLeftIcon aria-hidden="true" weight="bold" className="size-3.5" />
            </button>
            <span aria-live="polite" className="min-w-[3.25rem] text-center text-sm text-kumo-subtle tabular-nums">{index + 1} of {changes.length}</span>
            <button type="button" aria-label="Next change" className={STEP} disabled={index === changes.length - 1} onClick={() => onFocus(changes[index + 1].actionId)}>
              <CaretRightIcon aria-hidden="true" weight="bold" className="size-3.5" />
            </button>
          </div>
        )}
        {/* Keyed, so that stepping slides the next one in rather than changing the words in place. */}
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={current.actionId}
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={transition}
            className="min-w-0 flex-1 px-2 @max-md:order-first @max-md:basis-full @max-md:pt-0.5 @max-md:pb-1"
          >
            <span id={`${id}-title`} className="block truncate text-base/5 font-medium text-kumo-default">{current.title}</span>
            {!restricted && <span className="block truncate text-sm text-kumo-subtle">{changeLine(current)}</span>}
          </motion.div>
        </AnimatePresence>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" disabled={busy} aria-describedby={`${id}-title`} onClick={() => run(() => onDeny(current.actionId))}>Deny</Button>
          <Button variant={many ? 'secondary' : 'primary'} disabled={busy} aria-describedby={`${id}-title`} onClick={() => run(() => onApprove(current.actionId))}>Approve</Button>
        </span>
      </div>

      )}

      {restricted && (
        <div className="max-h-48 overflow-y-auto border-t border-kumo-line px-4 py-3">
          {current.description && <div className="text-sm text-kumo-default"><Markdown>{current.description}</Markdown></div>}
          <ActionFields fields={current.fields} uncapped />
        </div>
      )}

      {many && !creates && (
        <div className="flex items-center gap-2 border-t border-kumo-line bg-kumo-tint/60 py-1.5 ps-4 pe-2">
          {progress ? (
            <span role="status" className="flex-1 py-2 text-sm text-kumo-subtle tabular-nums">
              {progress.verb} {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </span>
          ) : confirming ? (
            <>
              <span role="alert" className="flex-1 text-sm text-kumo-default">Deny all {changes.length}?</span>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
              <Button variant="danger" onClick={() => { setConfirming(false); run(onDenyAll) }}>Deny all</Button>
            </>
          ) : (
            <>
              <span className="flex-1 text-sm text-kumo-subtle">{changes.length} changes wait</span>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>Deny all</Button>
              {!restricted && <Button variant="primary" disabled={busy} onClick={() => run(onApproveAll)}>Approve all</Button>}
            </>
          )}
        </div>
      )}
    </motion.section>
  )
}
