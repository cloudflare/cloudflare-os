import { useEffect, useRef } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowRight, CaretRight, Check, Lightning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'
import type { AgentSummary } from './agentList'
import { formatLastRun, formatRunAge, hasPendingChanges, needsReview } from './agentList'
import { UnreadBadge } from '../../notifications/UnreadBadge'
import { RunApprovalPopover } from './RunApprovalPopover'
import { RunUnreadMenu } from './RunUnreadMenu'

const countRuns = (count: number) => `${count} ${count === 1 ? 'run' : 'runs'}`

const RunRow = ({
  run, now, activityLine, approvals, review, restricted, selected, workspaceId, overseer, onOpen,
}: {
  run: AiChatMetadata
  now: Date
  activityLine: string | undefined
  /** Action approvals attached to this run, which its Review button opens in place. */
  approvals: ActionLogEntry[]
  /** The run has a request to review (see `needsReview`), whether or not it is an approval. */
  review: boolean
  restricted: boolean
  selected: boolean
  workspaceId: string | undefined
  overseer: RpcStub<Overseer>
  onOpen: () => void
}) => {
  const hasApprovals = approvals.length > 0
  const changes = hasPendingChanges(run)
  const rowRef = useRef<HTMLButtonElement>(null)
  const reviewingRef = useRef(false)

  // Deciding the last request takes the popover away with the Review button it was anchored to,
  // and the focus inside it with them. The run's row is where the user was.
  useEffect(() => {
    if (hasApprovals || !reviewingRef.current) return
    reviewingRef.current = false
    rowRef.current?.focus()
  }, [hasApprovals])

  // The one control on the row that does more than open the run: an approval is answered in
  // place. A connection or web-fetch request is answered on its card in the run, so that one's
  // Review opens the run too.
  const reviewButton = (
    <Button
      size="xs"
      variant="secondary"
      aria-label={`Review ${run.title}`}
      className="flex-shrink-0"
      onClick={hasApprovals ? undefined : onOpen}
    >
      Review
    </Button>
  )

  return (
    <div className="group flex items-center gap-0.5">
      <div
        className={`flex min-w-0 flex-1 items-center rounded-md ${
          review || changes ? 'bg-kumo-warning-tint/60 pr-1' : ''
        }`}
      >
        <button
          ref={rowRef}
          type="button"
          onClick={onOpen}
          aria-current={selected ? 'true' : undefined}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
            review || changes
              ? 'hover:bg-kumo-warning-tint/60'
              : selected ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/60'
          }`}
        >
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center" aria-hidden="true">
            {review || changes ? (
              <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" />
            ) : run.activeAgent ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-kumo-brand" />
            ) : (
              // "Nothing is waiting on you", not "it succeeded": a run that failed or was stopped
              // clears `activeAgent` exactly as a finished one does, so the client cannot tell
              // them apart and this mark must not claim to.
              <Check size={11} weight="bold" className="text-kumo-inactive" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[17px] tracking-[-0.2px] text-kumo-subtle">
            {run.title}
          </span>
          {review ? null : changes ? (
            // Unaccepted work is reviewed against its code, in the run, which is where the row goes.
            <span className="flex flex-shrink-0 items-center gap-1 text-[11.5px] leading-4 font-semibold text-kumo-warning">
              Changes
              <ArrowRight size={10} weight="bold" aria-hidden="true" />
            </span>
          ) : activityLine ? (
            <span className="max-w-[45%] flex-shrink-0 truncate text-[11px] leading-4 text-kumo-inactive">
              {activityLine}
            </span>
          ) : (
            <span className="flex-shrink-0 text-[11px] leading-4 tabular-nums text-kumo-inactive">
              {formatRunAge(run.lastActive, now)}
            </span>
          )}
        </button>
        {review && (hasApprovals ? (
          <RunApprovalPopover
            overseer={overseer}
            records={approvals}
            restricted={restricted}
            onOpenRun={onOpen}
            onOpenChange={open => { reviewingRef.current = open }}
          >
            {reviewButton}
          </RunApprovalPopover>
        ) : reviewButton)}
      </div>
      <RunUnreadMenu workspaceId={workspaceId} run={run} overseer={overseer} />
    </div>
  )
}

/**
 * One agent in the Agents list, collapsed to a single row.
 *
 * Collapsed is the resting state: an agent that fires every morning costs one row, not one row
 * per firing. Expanding gives the whole history rather than a sample of it, since the question
 * being asked — which of these did what, and when — is not one a preview can answer; the header
 * stays put as the runs scroll so that closing it again is always one click away.
 */
export const AgentListRow = ({
  agent, now, expanded, onToggle, onOpenAgent, workspaceId, overseer, pendingForRun, restricted,
  selectedChatId, onOpenRun, activityLineOf,
}: {
  agent: AgentSummary
  now: Date
  expanded: boolean
  onToggle: () => void
  onOpenAgent: () => void
  workspaceId: string | undefined
  overseer: RpcStub<Overseer>
  /** Action approvals awaiting the user, by run id. */
  pendingForRun: ReadonlyMap<number, ActionLogEntry[]>
  /** The workspace has read restricted data, which every approve surface has to say. */
  restricted: boolean
  selectedChatId: number | null
  onOpenRun: (chatId: number) => void
  activityLineOf: (chatId: number) => string | undefined
}) => {
  // One count can cover both kinds of attention, so name each rather than calling them all by
  // whichever ranked highest.
  const reviews = agent.runs.filter(run => needsReview(run, pendingForRun)).length
  const changes = agent.runs.filter(
    run => !needsReview(run, pendingForRun) && hasPendingChanges(run),
  ).length
  const waitingLabel = [
    reviews > 0 && `${countRuns(reviews)} needing your review`,
    changes > 0 && `${countRuns(changes)} with pending changes`,
  ].filter(Boolean).join(', ')

  return (
    <div className={expanded ? 'rounded-lg bg-kumo-tint/40 pb-1' : ''}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
          // An agent with a day's runs under it is taller than the list: keep the control that
          // closes it on screen the whole way down. Both of its backgrounds are opaque and it
          // sticks over the list's own padding, since runs pass underneath.
          expanded
            ? 'sticky -top-3 z-10 bg-kumo-tint hover:bg-kumo-fill'
            : 'hover:bg-kumo-tint/60'
        }`}
      >
        <CaretRight
          size={11}
          weight="bold"
          aria-hidden="true"
          className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${expanded ? 'rotate-90' : ''}`}
        />
        <Lightning size={13} aria-hidden="true" className="flex-shrink-0 text-kumo-inactive" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
          {agent.name}
        </span>
        <UnreadBadge count={agent.unread} />
        {agent.waiting > 0 && (
          <span
            className="flex flex-shrink-0 items-center gap-1 text-[11.5px] leading-4 font-semibold text-kumo-warning"
            // The row shows a bare count; what kind of attention it is only becomes visible on
            // expanding, so spell it out for anyone who cannot see the colour.
            aria-label={waitingLabel}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" aria-hidden="true" />
            {agent.waiting}
          </span>
        )}
        {agent.running > 0 && (
          <span
            className="flex flex-shrink-0 items-center gap-1 text-[11.5px] leading-4 font-medium text-kumo-brand"
            aria-label={`${agent.running} running`}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-kumo-brand" aria-hidden="true" />
            {agent.running}
          </span>
        )}
        <span className="flex-shrink-0 text-[11.5px] leading-4 tabular-nums text-kumo-inactive">
          {/* A dormant agent would otherwise show "0 today" and say nothing about when it last ran. */}
          {agent.today > 0 ? `${agent.today} today` : formatLastRun(agent.lastRun, now)}
        </span>
      </button>

      {expanded && (
        <div className="ml-[13px] border-l border-kumo-line pl-2">
          {agent.runs.map(run => (
            <RunRow
              key={run.id}
              run={run}
              now={now}
              activityLine={run.activeAgent ? activityLineOf(run.id) : undefined}
              approvals={pendingForRun.get(run.id) ?? []}
              review={needsReview(run, pendingForRun)}
              restricted={restricted}
              selected={run.id === selectedChatId}
              workspaceId={workspaceId}
              overseer={overseer}
              onOpen={() => onOpenRun(run.id)}
            />
          ))}
          <button
            type="button"
            onClick={onOpenAgent}
            className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left text-[11.5px] leading-4 font-medium text-kumo-brand transition-colors hover:text-kumo-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            Open agent
            <ArrowRight size={10} weight="bold" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
