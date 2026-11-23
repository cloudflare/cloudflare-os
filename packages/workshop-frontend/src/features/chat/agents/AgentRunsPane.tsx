import { useState } from 'react'
import { CaretLeft } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { useResolveAction } from '../../../useResolveAction'
import type { AgentSummary } from './agentList'
import { formatLastRun, hasPendingChanges, needsReview } from './agentList'
import { PendingApprovalCard } from './PendingApprovalCard'
import { RunUnreadMenu } from './RunUnreadMenu'

const RunRow = ({ run, now, activityLine, review, selected, workspaceId, overseer, onOpen }: {
  run: AiChatMetadata
  now: Date
  activityLine: string | undefined
  review: boolean
  selected: boolean
  workspaceId: string | undefined
  overseer: RpcStub<Overseer>
  onOpen: () => void
}) => (
  <div className="group flex items-center gap-0.5">
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
        selected ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/60'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
          review || hasPendingChanges(run)
            ? 'bg-kumo-warning'
            : run.activeAgent ? 'animate-pulse bg-kumo-brand' : 'bg-kumo-interact'
        }`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
        {run.title}
      </span>
      {activityLine && (
        <span className="max-w-[40%] flex-shrink-0 truncate text-[11.5px] leading-4 text-kumo-inactive">
          {activityLine}
        </span>
      )}
      {!activityLine && (review || hasPendingChanges(run)) && (
        <span className="flex-shrink-0 text-[11.5px] leading-4 font-medium text-kumo-warning">
          {review ? 'Review' : 'Pending changes'}
        </span>
      )}
      <span className="w-[72px] flex-shrink-0 text-right text-[11.5px] leading-4 tabular-nums text-kumo-inactive">
        {formatLastRun(run.lastActive, now)}
      </span>
    </button>
    <RunUnreadMenu workspaceId={workspaceId} run={run} overseer={overseer} />
  </div>
)

/**
 * One agent's runs: every chat it has started, newest first.
 *
 * Action approvals attached to a run are lifted to the top in full, since making someone open each
 * run to find them would waste the trip. Connection and web-fetch decisions remain in the run:
 * their controls own chat-level flows that this pane should not duplicate.
 */
export const AgentRunsPane = ({
  agent, now, workspaceId, overseer, pendingForRun, restricted, selectedChatId, onOpenRun, onBack,
  activityLineOf,
}: {
  agent: AgentSummary
  now: Date
  workspaceId: string | undefined
  overseer: RpcStub<Overseer>
  /** Action approvals awaiting the user, by run id. */
  pendingForRun: ReadonlyMap<number, ActionLogEntry[]>
  /** The workspace has read restricted data, which every approve surface has to say. */
  restricted: boolean
  selectedChatId: number | null
  onOpenRun: (chatId: number) => void
  /** Leaves the pane; only rendered when there is nowhere else for the list to go. */
  onBack?: () => void
  activityLineOf: (chatId: number) => string | undefined
}) => {
  const [processing, setProcessing] = useState<Set<number>>(new Set())
  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessing)
  const waiting = agent.runs.flatMap(run => pendingForRun.get(run.id) ?? [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to agents"
            className="-ml-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint/60 hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            <CaretLeft size={13} weight="bold" />
          </button>
        )}
        <h2 className="m-0 min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
          {agent.name}
        </h2>
        <span className="flex-shrink-0 text-[11.5px] leading-4 text-kumo-inactive">
          {agent.runs.length} {agent.runs.length === 1 ? 'run' : 'runs'}
          {/* Four places, as the chat rows use: a small scheduled task's whole day comes to a
              fraction of a cent, and two places would round that to "$0.00" here while the same
              runs read "$0.0012" in the list. */}
          {agent.cost != null && ` · $${agent.cost.toFixed(4)}`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {waiting.length > 0 && (
          <section className="mb-4 flex flex-col gap-2">
            <h3 className="m-0 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
              {waiting.length === 1 ? 'Waiting on you' : `Waiting on you (${waiting.length})`}
            </h3>
            {waiting.map(record => (
              <PendingApprovalCard
                key={record.id}
                record={record}
                restricted={restricted}
                busy={processing.has(record.id)}
                onResolve={decision => void resolveAction(record, decision)}
              />
            ))}
          </section>
        )}

        <div className="flex flex-col gap-0.5">
          {agent.runs.map(run => (
            <RunRow
              key={run.id}
              run={run}
              now={now}
              activityLine={run.activeAgent ? activityLineOf(run.id) : undefined}
              review={needsReview(run, pendingForRun)}
              selected={run.id === selectedChatId}
              workspaceId={workspaceId}
              overseer={overseer}
              onOpen={() => onOpenRun(run.id)}
            />
          ))}
        </div>
      </div>
      {creationAccountModal}
    </div>
  )
}
