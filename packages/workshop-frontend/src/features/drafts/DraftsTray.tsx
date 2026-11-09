import { useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { ChevronRightIcon } from '../../components/icons/designIcons'
import { RequestButton } from '../chat/transcript/RequestCard'
import { DraftFileIcon } from './DraftFileIcon'
import { allDrafts, changeCount, type DraftGroup } from './drafts'
import type { DraftDecisions } from './useDraftDecisions'

const SHOWN_GROUPS = 3

/**
 * Everything the chat's agent drafted that is not applied yet, above the composer: one row per
 * file or mailbox, each opening its review, with one decision for all of it. A workspace that has
 * read restricted data offers no blind Apply all: each draft is read in its review first.
 */
export const DraftsTray = ({ groups, decisions, restricted, onReview }: {
  groups: readonly DraftGroup[]
  decisions: DraftDecisions
  restricted: boolean
  onReview: (group: DraftGroup) => void
}) => {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { run, working } = decisions
  const drafts = allDrafts(groups)
  if (drafts.length === 0 && run.status !== 'failed') return null

  const shown = expanded ? groups : groups.slice(0, SHOWN_GROUPS)
  const hidden = groups.length - shown.length
  const holdsAgent = groups.some(group => group.holdsAgent)

  return (
    <section
      aria-label="Drafted changes"
      className="mx-3 mb-2 overflow-hidden rounded-[20px] bg-kumo-base shadow-[0_2px_6px_rgba(0,0,0,0.03)] ring-1 ring-kumo-line"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 pt-3 pb-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium leading-[18px] text-kumo-default">
              {changeCount(drafts.length)} drafted, not applied yet
            </span>
            {holdsAgent && (
              <span className="block text-[12px] leading-4 text-kumo-subtle">The agent is waiting for you to decide.</span>
            )}
          </span>
        </span>
        {run.status === 'working' ? (
          <span role="status" className="ml-auto text-[12.5px] leading-4 text-kumo-subtle">
            {run.decision === 'apply' ? 'Applying' : 'Discarding'} {Math.min(run.done + 1, run.total)} of {run.total}…
          </span>
        ) : confirmingDiscard ? (
          <span role="alert" className="ml-auto flex items-center gap-1.5">
            <span className="text-[12.5px] leading-4 text-kumo-default">Discard all {drafts.length}?</span>
            <RequestButton tone="quiet" onClick={() => setConfirmingDiscard(false)}>Keep</RequestButton>
            <RequestButton tone="secondary" onClick={() => {
              setConfirmingDiscard(false)
              void decisions.decide(drafts, 'discard')
            }}>
              Discard
            </RequestButton>
          </span>
        ) : drafts.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <RequestButton tone="quiet" disabled={working} onClick={() => setConfirmingDiscard(true)}>
              Discard
            </RequestButton>
            {!restricted && (
              <RequestButton tone="primary" disabled={working} onClick={() => void decisions.decide(drafts, 'apply')}>
                {drafts.length === 1 ? 'Apply' : `Apply all ${drafts.length}`}
              </RequestButton>
            )}
          </span>
        )}
      </header>

      {run.status === 'failed' && (
        <div role="alert" className="mx-2 mb-1 flex flex-wrap items-start gap-2 rounded-xl bg-kumo-danger-tint px-3 py-2 text-[12.5px] leading-[17px] text-kumo-default">
          <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-px shrink-0 text-kumo-danger" />
          <span className="min-w-[12rem] flex-1">
            {run.done > 0 && `${run.decision === 'apply' ? 'Applied' : 'Discarded'} ${run.done} of ${run.total}. `}
            Couldn’t {run.decision} “{run.failed.description.title}”
            {run.reason ? `: ${run.reason}` : '. Check your connection and try again.'}
          </span>
          <RequestButton tone="quiet" onClick={decisions.dismissFailure}>Dismiss</RequestButton>
          <RequestButton tone="secondary" onClick={() => void decisions.retry()}>Try again</RequestButton>
        </div>
      )}

      <ul className="m-0 list-none px-1.5 pb-1.5">
        {shown.map(group => (
          <li key={group.key}>
            <button
              type="button"
              onClick={() => onReview(group)}
              className="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <DraftFileIcon kind={group.kind} size={18} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-kumo-default">{group.title}</span>
              <span className="shrink-0 text-[12.5px] leading-4 text-kumo-subtle">
                {group.holdsAgent ? 'Waiting on you' : group.drafts.some(draft => draft.creation) ? 'New' : changeCount(group.drafts.length)}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium leading-4 text-kumo-default">
                Review
                <ChevronRightIcon size={14} className="text-kumo-subtle transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full cursor-pointer rounded-xl px-2 py-1.5 text-left text-[12.5px] leading-4 text-kumo-subtle hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              {hidden} more
            </button>
          </li>
        )}
      </ul>
      {decisions.creationAccountModal}
    </section>
  )
}
