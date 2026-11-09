import { useId, useState, type ReactNode } from 'react'
import { ArrowClockwise, CaretLeft, CaretRight, Check, WarningCircle } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { ActionFields, entryFields } from '../../components/ActionFields'
import { IncompleteDescriptionNotice, isDescriptionIncomplete } from '../../components/IncompleteDescriptionNotice'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { MarkdownMessage } from '../../ChatInterface'
import { RequestButton } from '../chat/transcript/RequestCard'
import type { ChangeDecision } from '../resource-preview/changeMarks'
import { loadingPreview } from '../resource-preview/loadingPreview'
import { ResourcePreviewView } from '../resource-preview/ResourcePreviewView'
import { changeCount, drawsPreview, type Draft, type DraftGroup } from './drafts'
import { useDraftDecisions, type DraftDecisions } from './useDraftDecisions'
import { newFilePreview } from './newFilePreview'
import { useResourcePreview } from './useResourcePreview'

const STEP_BUTTON = 'flex size-7 cursor-pointer items-center justify-center rounded-full text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'

const KIND_NOUN: Record<DraftGroup['kind'], string> = {
  document: 'document', spreadsheet: 'spreadsheet', presentation: 'presentation', email: 'email', other: 'item',
}

/** A draft's first line of what it does, for a bar too narrow for its whole description. */
const draftSnippet = (draft: Draft) => {
  const first = entryFields(draft)[0]
  const value = first && 'value' in first ? first.value : first && 'items' in first ? first.items.join(', ') : undefined
  const text = first && value !== undefined ? `${first.label}: ${value}` : draft.description.description
  const flat = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

const Bar = ({ children }: { children: ReactNode }) => (
  <div
    role="region"
    aria-label="Review drafts"
    className="themed-floating-shadow pointer-events-auto mx-auto w-full max-w-[600px] overflow-hidden rounded-[20px] bg-kumo-base ring-1 ring-kumo-line"
  >
    {children}
  </div>
)

const FailureLine = ({ decisions }: { decisions: DraftDecisions }) => {
  const { run } = decisions
  if (run.status !== 'failed') return null
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 border-b border-kumo-line bg-kumo-danger-tint px-3.5 py-2.5 text-[12.5px] leading-[17px] text-kumo-default">
      <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-px shrink-0 text-kumo-danger" />
      <span className="min-w-[12rem] flex-1">
        {run.done > 0 && `${run.decision === 'apply' ? 'Applied' : 'Discarded'} ${run.done} of ${run.total}. `}
        Couldn’t {run.decision} “{run.failed.description.title}”
        {run.reason ? `: ${run.reason}` : '. Check your connection and try again.'}
      </span>
      <RequestButton tone="quiet" onClick={decisions.dismissFailure}>Dismiss</RequestButton>
      <RequestButton tone="secondary" onClick={() => void decisions.retry()}>Try again</RequestButton>
    </div>
  )
}

/**
 * Applies or discards everything left, with discarding all asking once before it goes. `creates`
 * names the new file the drafts make, which is created or discarded whole.
 */
const AllControls = ({ waiting, decisions, creates }: {
  waiting: readonly Draft[]
  decisions: DraftDecisions
  creates?: string
}) => {
  const [confirming, setConfirming] = useState(false)
  if (decisions.run.status === 'working') {
    const { run } = decisions
    return (
      <span role="status" aria-live="polite" className="ml-auto text-[12.5px] leading-4 text-kumo-subtle">
        {run.decision === 'apply' ? 'Applying' : 'Discarding'} {Math.min(run.done + 1, run.total)} of {run.total}…
      </span>
    )
  }
  if (confirming) {
    return (
      <span role="alert" className="ml-auto flex items-center gap-1.5">
        <span className="text-[12.5px] leading-4 text-kumo-default">
          {creates ? `Discard this ${creates}?` : `Discard all ${waiting.length}?`}
        </span>
        <RequestButton tone="quiet" onClick={() => setConfirming(false)}>Keep</RequestButton>
        <RequestButton tone="secondary" onClick={() => {
          setConfirming(false)
          void decisions.decide(waiting, 'discard')
        }}>
          Discard
        </RequestButton>
      </span>
    )
  }
  return (
    <span className="ml-auto flex items-center gap-1.5">
      <RequestButton tone="quiet" onClick={() => setConfirming(true)}>
        {waiting.length === 1 || creates ? 'Discard' : 'Discard all'}
      </RequestButton>
      <RequestButton tone="primary" onClick={() => void decisions.decide(waiting, 'apply')}>
        {creates ? `Create ${creates}` : waiting.length === 1 ? 'Apply' : `Apply all ${waiting.length}`}
      </RequestButton>
    </span>
  )
}

/** Once nothing is left to decide: what happened, in one line. */
const Outcome = ({ decided, url, noun }: { decided: ReadonlyMap<number, ChangeDecision>; url?: string; noun: string }) => {
  const applied = [...decided.values()].filter(state => state === 'approved').length
  const discarded = decided.size - applied
  const outcome = [
    applied > 0 && `Applied ${changeCount(applied)}`,
    discarded > 0 && `${applied > 0 ? 'discarded' : 'Discarded'} ${discarded}`,
  ].filter(Boolean).join(', ')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-2 pl-3.5">
      <Check size={14} weight="bold" aria-hidden="true" className="shrink-0 text-kumo-success" />
      <p role="status" className="m-0 min-w-0 flex-1 text-[13px] leading-[18px] text-kumo-default">
        {outcome || `Nothing is waiting on this ${noun}.`}
      </p>
      {url && applied > 0 && (
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="shrink-0 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-kumo-default hover:bg-kumo-tint">
          Open ↗
        </a>
      )}
    </div>
  )
}

/**
 * Everything the chat drafted for one file, reviewed on the file: the pane draws it as it will be
 * once the drafts apply, each change marked where it lands, and a bar over it steps through them,
 * decides one, or applies them all at once.
 *
 * Where the file can't be drawn (an email, a connection that draws nothing, anyone but the
 * workspace's owner, a failure) or the workspace has read restricted data, which must be read in
 * full before anything is approved, each draft is listed with exactly what it will do instead.
 */
export const DraftReviewPane = ({ overseer, group, restricted, url }: {
  overseer: RpcStub<Overseer>
  group: DraftGroup
  restricted: boolean
  url?: string
}) => {
  const listId = useId()
  const noticeId = `${listId}-restricted`
  const [decided, setDecided] = useState<ReadonlyMap<number, ChangeDecision>>(new Map())
  const decisions = useDraftDecisions(overseer, (draft, decision) => setDecided(previous =>
    new Map(previous).set(draft.id, decision === 'apply' ? 'approved' : 'rejected')))
  const [seen, setSeen] = useState<readonly Draft[]>(group.drafts)
  const [pickedId, setPickedId] = useState<number | null>(null)
  // Remember every draft shown while the pane is open, so one decided here still has its outcome.
  const unseen = group.drafts.filter(draft => !seen.some(known => known.id === draft.id))
  if (unseen.length > 0) setSeen([...seen, ...unseen])

  const waiting = group.drafts.filter(draft => !decided.has(draft.id))
  const waitingIds = waiting.map(draft => draft.id).join(',')
  // A file not created yet names no kind, but its connection may draw it as the blank file with
  // its drafts applied; the kind is then the drawing's. Kept once the creation applies.
  const [creates] = useState(() => group.drafts.some(draft => draft.creation))
  const wantsPreview = (drawsPreview(group.kind) || creates) && !restricted
  const { state: preview, retry } = useResourcePreview(
    overseer, group.gatekeeperId, group.subjectId ?? null, wantsPreview ? waitingIds : null)
  const kind = preview.status === 'ready' ? preview.preview.content.type : group.kind
  const noun = KIND_NOUN[kind]

  const decide = (drafts: readonly Draft[], decision: 'apply' | 'discard') =>
    void decisions.decide(drafts, decision)

  const index = Math.max(0, waiting.findIndex(draft => draft.id === pickedId))
  const current = waiting[index] as Draft | undefined

  const shown = !wantsPreview ? null
    : preview.status === 'ready' ? preview.preview
    : preview.status === 'loading' && drawsPreview(group.kind)
      ? loadingPreview(group.kind as 'document' | 'spreadsheet' | 'presentation')
    : null

  if (wantsPreview && !shown && preview.status === 'loading') {
    return <div role="status" aria-label={`Opening ${group.title}`} className="h-full bg-kumo-recessed" />
  }

  // A file not created yet is decided whole: it is drawn as the new file, not as its edits.
  if (shown && waiting.some(draft => draft.creation)) {
    return (
      <section aria-label={`${group.title}, as it will be`} className="relative h-full min-h-0">
        <ResourcePreviewView
          preview={newFilePreview(shown)}
          loading={preview.status === 'loading'}
          focusedChangeId={null}
          decided={decided}
          onChangeClick={() => {}}
          overlay={(
            <Bar>
              <FailureLine decisions={decisions} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-2 pl-3.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium leading-[18px] text-kumo-default">{group.title}</span>
                    <span className="shrink-0 rounded-md bg-kumo-tint px-1.5 text-[11px] font-medium leading-4 text-kumo-subtle">New</span>
                  </span>
                  <span className="block truncate text-[12px] leading-4 text-kumo-subtle">
                    Not created yet
                  </span>
                </span>
                <AllControls waiting={waiting} decisions={decisions} creates={noun} />
              </div>
            </Bar>
          )}
        />
        {decisions.creationAccountModal}
      </section>
    )
  }

  if (shown) {
    const bar = (
      <Bar>
        <FailureLine decisions={decisions} />
        {current ? (
          <>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pt-2 pb-1">
              {waiting.length > 1 && (
                <div className="flex shrink-0 items-center">
                  <button type="button" aria-label="Previous change" className={STEP_BUTTON}
                    disabled={index === 0} onClick={() => setPickedId(waiting[index - 1].id)}>
                    <CaretLeft size={14} weight="bold" />
                  </button>
                  <span className="min-w-[3.25rem] text-center text-[12px] tabular-nums text-kumo-subtle" aria-live="polite">
                    {index + 1} of {waiting.length}
                  </span>
                  <button type="button" aria-label="Next change" className={STEP_BUTTON}
                    disabled={index === waiting.length - 1} onClick={() => setPickedId(waiting[index + 1].id)}>
                    <CaretRight size={14} weight="bold" />
                  </button>
                </div>
              )}
              <div className="min-w-0 flex-1 px-1.5">
                <span className="block truncate text-[13px] font-medium leading-[18px] text-kumo-default">
                  {current.description.title}
                </span>
                <span className="block truncate text-[12px] leading-4 text-kumo-subtle">{draftSnippet(current)}</span>
              </div>
              {waiting.length > 1 && (
                <span className="flex shrink-0 items-center gap-1">
                  <RequestButton tone="quiet" disabled={decisions.working} aria-label={`Discard: ${current.description.title}`}
                    onClick={() => decide([current], 'discard')}>
                    Discard
                  </RequestButton>
                  <RequestButton tone="secondary" disabled={decisions.working} aria-label={`Apply: ${current.description.title}`}
                    onClick={() => decide([current], 'apply')}>
                    Apply
                  </RequestButton>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line bg-kumo-elevated py-1.5 pr-2 pl-3.5">
              <span className="min-w-0 flex-1 text-[12px] leading-4 text-kumo-subtle">
                {changeCount(waiting.length)} waiting
              </span>
              <AllControls waiting={waiting} decisions={decisions} />
            </div>
          </>
        ) : (
          <Outcome decided={decided} url={url ?? shown.url} noun={noun} />
        )}
      </Bar>
    )
    return (
      <section aria-label={`${group.title}, as it will be`} className="relative h-full min-h-0">
        <ResourcePreviewView
          preview={shown}
          loading={preview.status === 'loading'}
          focusedChangeId={current?.id ?? null}
          decided={decided}
          onChangeClick={setPickedId}
          overlay={seen.length > 0 || decisions.run.status === 'failed' ? bar : undefined}
        />
        {preview.status === 'ready' && preview.refreshing && (
          <span role="status" className="absolute top-3 right-3 z-10 rounded-full bg-kumo-base px-2.5 py-1 text-[11.5px] font-medium text-kumo-subtle ring-1 ring-kumo-line">
            Updating…
          </span>
        )}
        {decisions.creationAccountModal}
      </section>
    )
  }

  const listed = seen.map(known => group.drafts.find(draft => draft.id === known.id) ?? known)
    .toSorted((a, b) => a.id - b.id)
  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-recessed">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-[640px] space-y-3">
          {preview.status === 'failed' && wantsPreview && (
            <div className="flex items-start gap-3 rounded-2xl bg-kumo-base px-4 py-3 ring-1 ring-kumo-line">
              <WarningCircle size={18} weight="fill" aria-hidden="true" className="mt-px shrink-0 text-kumo-inactive" />
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13.5px] font-medium leading-[18px] text-kumo-default">Couldn’t open {group.title}</p>
                <p className="m-0 mt-0.5 text-[12.5px] leading-[17px] text-kumo-subtle">
                  {preview.message} Each change is still listed exactly as it will be made.
                </p>
              </div>
              <RequestButton tone="quiet" disabled={preview.refreshing} onClick={retry}>
                <ArrowClockwise size={12} weight="bold" aria-hidden="true" /> Try again
              </RequestButton>
            </div>
          )}
          {restricted && waiting.length > 0 && <RestrictedApprovalNotice id={noticeId} />}
          {listed.length === 0 ? (
            <p className="m-0 rounded-2xl bg-kumo-base p-8 text-center text-[13px] text-kumo-subtle ring-1 ring-kumo-line">
              Nothing is waiting on this {noun}.
            </p>
          ) : (
            <ol className="m-0 list-none space-y-2 p-0" aria-label="Drafts">
              {listed.map(draft => {
                const outcome = decided.get(draft.id)
                const stillWaiting = group.drafts.some(known => known.id === draft.id)
                const incompleteId = `${listId}-${draft.id}-incomplete`
                const describedBy = restricted ? `${noticeId} ${listId}-${draft.id}-request` : undefined
                return (
                  <li key={draft.id} className="rounded-2xl bg-kumo-base p-3.5 ring-1 ring-kumo-line">
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                      <div className="min-w-0 flex-1 basis-[240px]">
                        <p className="m-0 text-[14px] font-medium leading-[18px] text-kumo-default">{draft.description.title}</p>
                        <div id={`${listId}-${draft.id}-request`} className="mt-1 text-[13px] leading-[19px] text-kumo-subtle">
                          <MarkdownMessage message={draft.description.description} />
                          <ActionFields fields={entryFields(draft)} uncapped={restricted} className="mt-2" />
                        </div>
                        {stillWaiting && isDescriptionIncomplete(draft) && (
                          <IncompleteDescriptionNotice id={incompleteId} className="mt-2" />
                        )}
                      </div>
                      {outcome ? (
                        <span className="shrink-0 text-[12.5px] font-medium leading-4 text-kumo-subtle">
                          {outcome === 'approved' ? 'Applied' : 'Discarded'}
                        </span>
                      ) : stillWaiting ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <RequestButton tone="quiet" disabled={decisions.working} aria-describedby={describedBy}
                            onClick={() => decide([draft], 'discard')}>
                            Discard
                          </RequestButton>
                          <RequestButton tone="primary" disabled={decisions.working} aria-describedby={describedBy}
                            onClick={() => decide([draft], 'apply')}>
                            {draft.description.awaitDecision ? 'Approve' : 'Apply'}
                          </RequestButton>
                        </span>
                      ) : (
                        <span className="shrink-0 text-[12.5px] leading-4 text-kumo-subtle">Decided elsewhere</span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>
      {(waiting.length > 0 || decisions.run.status === 'failed') && (
        <div className="shrink-0 px-3 pb-3">
          <Bar>
            <FailureLine decisions={decisions} />
            {waiting.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 py-1.5 pr-2 pl-3.5">
                <span className="min-w-0 flex-1 text-[12px] leading-4 text-kumo-subtle">
                  {changeCount(waiting.length)} waiting
                </span>
                <AllControls waiting={waiting} decisions={decisions} />
              </div>
            )}
          </Bar>
        </div>
      )}
      {decisions.creationAccountModal}
    </div>
  )
}
