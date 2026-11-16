import { useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretRightIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { GoogleFileIcon } from '@/components/GoogleFileIcon'
import { Markdown } from '@/components/Markdown'
import type { ConnectedFileKind } from '@/files/connectedFile'
import { ActionFields, type ActionField } from './ActionFields'
import { usePending, type ActionResult } from './usePending'

/** One request waiting, as the tray unfolds it for a thing that is not drawn beside the chat. */
export type PendingTrayRequest = {
  actionId: number
  title: string
  /** The gatekeeper's own account of what it does, as Markdown. */
  description: string
  fields: ActionField[]
  /** Approves this kind from now on, where its gatekeeper allows that. */
  onAlwaysApprove?: () => ActionResult
}

/** Everything waiting on one thing, such as the edits to one Google Doc. */
export type PendingTrayGroup = {
  key: string
  title: string
  /** A Google file, shown in Drive's icon; anything else is a request to approve. */
  fileKind?: ConnectedFileKind
  /** What waits, in a few words: "3 changes", "New Google Doc". */
  summary: string
  /** One of them holds the agent until it is decided. */
  holdsAgent: boolean
  /**
   * Opens the thing beside the chat, drawn as it will be, to be reviewed change by change. Absent
   * for one reviewed here, which unfolds its requests in the tray instead.
   */
  onReview?: () => void
  /** It is open beside the chat already, being reviewed there. */
  reviewing?: boolean
  requests: PendingTrayRequest[]
}

export type PendingTrayProps = {
  groups: PendingTrayGroup[]
  /**
   * The workspace has read sensitive data: nothing is approved unread, so there is no Approve
   * all, and each request is shown in full before it is approved.
   */
  restricted?: boolean
  /** Decisions under way, one at a time: "Approving 2 of 4…". */
  progress?: { verb: 'Approving' | 'Denying'; done: number; total: number }
  /** Why the last decision did not go, with the rest left waiting. */
  problem?: string
  onDismissProblem?: () => void
  onApproveAll: () => ActionResult
  onDenyAll: () => ActionResult
  onApprove: (actionId: number) => ActionResult
  onDeny: (actionId: number) => ActionResult
}

const EASE = [0.25, 0.1, 0.25, 1] as const
// Rows open and close around what they hold, as the conversation's own live rows do.
const ROW = { initial: { height: 0, opacity: 0 }, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0 } }

const total = (groups: readonly PendingTrayGroup[]) => groups.reduce((sum, group) => sum + group.requests.length, 0)

const heading = (count: number) => `${count} ${count === 1 ? 'change waits' : 'changes wait'} for you`

const GroupIcon = ({ fileKind }: { fileKind?: ConnectedFileKind }) => (
  <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-kumo-fill text-kumo-default">
    {fileKind ? <GoogleFileIcon kind={fileKind} className="size-[18px]" /> : <ShieldCheckIcon aria-hidden="true" className="size-[18px]" />}
  </span>
)

const RequestRow = ({ request, restricted, busy, onApprove, onDeny }: {
  request: PendingTrayRequest
  restricted?: boolean
  busy: boolean
  onApprove: () => ActionResult
  onDeny: () => ActionResult
}) => {
  const [pending, run] = usePending()
  const id = useId()
  const disabled = busy || pending
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-2xl bg-kumo-tint px-3 py-2.5">
      <span id={`${id}-title`} className="text-sm font-medium text-kumo-default">{request.title}</span>
      <div id={`${id}-request`} className="flex flex-col gap-2">
        {request.description && <div className="text-sm text-kumo-default"><Markdown>{request.description}</Markdown></div>}
        <ActionFields fields={request.fields} uncapped={restricted} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {request.onAlwaysApprove && !restricted && (
          <Button variant="ghost" disabled={disabled} className="me-auto" onClick={() => run(request.onAlwaysApprove!)}>Always allow</Button>
        )}
        <Button disabled={disabled} aria-describedby={`${id}-request`} onClick={() => run(onDeny)}>Deny</Button>
        <Button variant="primary" disabled={disabled} aria-describedby={`${id}-request`} onClick={() => run(onApprove)}>Approve</Button>
      </div>
    </section>
  )
}

/**
 * What the chat's agent is waiting on the user for, docked above the composer so it is never
 * scrolled away: one row for each thing it would change (a Doc, a channel, an issue), saying how
 * much waits on it, and one decision for all of it. A Google file's row opens the file beside the
 * chat, drawn as it will be, to be reviewed change by change; anything else unfolds its requests
 * here, each with what it would send. Rows close as what they hold is decided, and the tray goes
 * once nothing waits.
 */
export const PendingTray = ({ groups, restricted, progress, problem, onDismissProblem, onApproveAll, onDenyAll, onApprove, onDeny }: PendingTrayProps) => {
  const reduced = useReducedMotion()
  const transition = reduced ? { duration: 0 } : { duration: 0.24, ease: EASE }
  const [open, setOpen] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const [pending, run] = usePending()
  const count = total(groups)
  const busy = pending || progress !== undefined
  const holdsAgent = groups.some((group) => group.holdsAgent)
  // One alone is unfolded from the start: there is nothing to choose between.
  const unfolded = groups.length === 1 && !groups[0].onReview ? groups[0].key : open

  return (
    <AnimatePresence initial={false}>
      {(count > 0 || problem) && (
        <motion.section
          key="tray"
          aria-label="Waiting for you"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={transition}
          className="pointer-events-auto mb-2 origin-bottom overflow-hidden rounded-[21px] bg-kumo-base ring-1 ring-kumo-line shadow-[0_4px_16px_rgb(0_0_0/0.06)]"
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 ps-4 pe-2">
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full bg-kumo-warning', holdsAgent && 'animate-pulse motion-reduce:animate-none')} />
              <span className="min-w-0">
                <span className="block truncate text-base/5 font-medium text-kumo-default">{count > 0 ? heading(count) : 'Nothing waits now'}</span>
                {holdsAgent && <span className="block text-sm text-kumo-subtle">The agent waits until you decide.</span>}
              </span>
            </span>
            {progress ? (
              <span role="status" className="px-2 text-sm text-kumo-subtle tabular-nums">
                {progress.verb} {Math.min(progress.done + 1, progress.total)} of {progress.total}…
              </span>
            ) : confirming ? (
              <span role="alert" className="flex items-center gap-2">
                <span className="text-sm text-kumo-default">{count === 1 ? 'Deny it?' : `Deny all ${count}?`}</span>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
                <Button variant="danger" onClick={() => { setConfirming(false); run(onDenyAll) }}>Deny</Button>
              </span>
            ) : count > 0 && (
              <span className="flex items-center gap-1">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{count === 1 ? 'Deny' : 'Deny all'}</Button>
                {!restricted && (
                  <Button variant="primary" disabled={busy} onClick={() => run(onApproveAll)}>{count === 1 ? 'Approve' : 'Approve all'}</Button>
                )}
              </span>
            )}
          </header>

          <AnimatePresence initial={false}>
            {problem && (
              <motion.div key="problem" {...ROW} transition={transition} className="overflow-hidden">
                <p role="alert" className="mx-2 mb-1.5 flex items-start gap-2 rounded-xl bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-default">
                  <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0 text-kumo-danger" />
                  <span className="min-w-0 flex-1">{problem}</span>
                  {onDismissProblem && <button type="button" className="shrink-0 font-medium text-kumo-default hover:underline" onClick={onDismissProblem}>Dismiss</button>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <ul className="flex max-h-[min(22rem,45vh)] flex-col overflow-y-auto overscroll-contain px-1.5 pb-1.5">
            <AnimatePresence initial={false}>
              {groups.map((group) => {
                const expanded = unfolded === group.key
                return (
                  <motion.li key={group.key} {...ROW} transition={transition} className="shrink-0 overflow-hidden">
                    <button
                      type="button"
                      aria-expanded={group.onReview ? undefined : expanded}
                      aria-current={group.reviewing || undefined}
                      onClick={() => (group.onReview ? group.onReview() : setOpen(expanded ? undefined : group.key))}
                      className={cn('group flex w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-left outline-none transition-colors duration-200 hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring motion-reduce:transition-none', group.reviewing && 'bg-kumo-tint')}
                    >
                      <GroupIcon fileKind={group.fileKind} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-base/5 text-kumo-default">{group.title}</span>
                        <span className="truncate text-sm text-kumo-subtle">{group.holdsAgent ? `${group.summary} · The agent is waiting` : group.summary}</span>
                      </span>
                      {group.reviewing ? (
                        <span className="shrink-0 text-sm text-kumo-subtle">Open beside</span>
                      ) : (
                      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-kumo-default">
                        {group.onReview ? 'Review' : expanded ? 'Hide' : 'Show'}
                        <CaretRightIcon
                          aria-hidden="true"
                          weight="bold"
                          className={cn(
                            'size-3.5 text-kumo-subtle transition-transform duration-200 motion-reduce:transition-none',
                            group.onReview ? 'group-hover:translate-x-0.5' : expanded && 'rotate-90',
                          )}
                        />
                      </span>
                      )}
                    </button>
                    <AnimatePresence initial={false}>
                      {expanded && (
                        <motion.div key="requests" {...ROW} transition={transition} className="overflow-hidden">
                          {/* Spaced by each row's own foot, so a row that closes takes its space with it. */}
                          <ul className="flex flex-col px-1 pt-1">
                            <AnimatePresence initial={false}>
                              {group.requests.map((request) => (
                                <motion.li key={request.actionId} {...ROW} transition={transition} className="overflow-hidden pb-1.5">
                                  <RequestRow
                                    request={request}
                                    restricted={restricted}
                                    busy={busy}
                                    onApprove={() => onApprove(request.actionId)}
                                    onDeny={() => onDeny(request.actionId)}
                                  />
                                </motion.li>
                              ))}
                            </AnimatePresence>
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ul>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
