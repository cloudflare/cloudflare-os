import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Dialog, Loader } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { ActionFields, entryFields, formatSize } from '../../components/ActionFields'
import { ResolveButton } from '../../components/ResolveButton'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { PushReviewCommitView } from './PushReviewCommitView'
import { PushReviewFileView } from './PushReviewFileView'
import { PushReviewList } from './PushReviewList'
import {
  groupPushReview, notShownAsText, reviewItems, reviewReadiness, reviewTooLarge, shortOid, tooLargeToReview,
  type PathRow, type ReviewItem,
} from './pushReviewModel'
import { usePushReview } from './usePushReview'
import { usePushReviewFiles } from './usePushReviewFiles'

const statementClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'
const captionClass = 'm-0 text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle'

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

// "#3", "#3 and #5", "#3, #5 and #7".
const requestList = (ids: readonly number[]) => {
  const names = ids.map(id => `#${id}`)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
}

/**
 * Everything a pending push will send, for the person deciding on it: its commits, each with its
 * whole text, and the paths each changes, each file as a diff. It is built from what the push is
 * marked to send (Overseer.getPushReview()), so what it lists is what leaves.
 *
 * Outside a workspace that holds restricted data it is an offer, and reads a page or a file when
 * asked. While `restricted` it is where the push is approved: it loads the whole review by
 * itself, and Approve is enabled once every page and every file listed as text has loaded as
 * listed, whatever the approver has opened. A push too large to load unasked is loaded by hand
 * and then approved by the same rule. Mount it while it should be open.
 */
export const PushReviewDialog = ({ overseer, record, restricted, processing, onApprove, onReject, onClose }: {
  overseer: RpcStub<Overseer>
  record: ActionLogEntry
  /** The workspace holds restricted data: the review carries the decision and its notice. */
  restricted: boolean
  processing: boolean
  onApprove: () => void
  onReject: () => void
  onClose: () => void
}) => {
  const review = usePushReview(overseer, record.id, restricted)
  const { entries } = review
  const tooLarge = reviewTooLarge(entries, review.objectCount)
  // The list is rebuilt per page, not per keystroke that moves the selection.
  const { items, pathRows, commitCount, pathCount, unshown } = useMemo(() => {
    const grouped = groupPushReview(entries)
    const list = reviewItems(grouped)
    return {
      items: list,
      pathRows: entries.filter((entry): entry is PathRow => entry.kind === 'path'),
      commitCount: grouped.commits.length,
      pathCount: list.filter(item => item.kind === 'path').length,
      unshown: notShownAsText(entries),
    }
  }, [entries])
  const files = usePushReviewFiles(overseer, pathRows, restricted && !tooLarge)

  const [selectedKey, setSelectedKey] = useState<string>()
  const selected = items.find(item => item.key === selectedKey) ?? items.at(0)
  const select = (item: ReviewItem) => {
    setSelectedKey(item.key)
    // A file listed as text is read when its row is opened; one of any size only on request.
    if (item.kind === 'path' && item.row.sent?.kind === 'text') files.request(item.row)
  }

  // Focus starts in the list, on the first commit, once there is one.
  const bodyRef = useRef<HTMLDivElement>(null)
  const listFocused = useRef(false)
  const listed = items.length > 0
  useEffect(() => {
    if (!listed || listFocused.current) return
    listFocused.current = true
    bodyRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus()
  }, [listed])

  const fields = entryFields(record)
  const request = record.description.description
  const reviewId = useId()
  const noticeId = `${reviewId}-notice`
  const requestId = `${reviewId}-request`
  const fieldsId = `${reviewId}-fields`
  const readinessId = `${reviewId}-readiness`
  const describedBy = [
    noticeId, ...(request ? [requestId] : []), ...(fields.length > 0 ? [fieldsId] : []), readinessId,
  ].join(' ')

  const readiness = reviewReadiness(
    {
      entries: entries.length, done: review.done, truncated: review.truncated, loading: review.loading,
      failed: review.error !== undefined,
    },
    { ...files, eager: !tooLarge })
  const help = readiness.ready ? undefined
    : readiness.retry === 'review' ? { label: 'Retry', run: review.retry }
      : readiness.retry === 'files' ? { label: 'Retry', run: files.retry }
        : readiness.load === 'review' ? { label: 'Load more', run: review.loadMore }
          : readiness.load === 'files' ? { label: 'Load files', run: files.requestAll }
            : undefined

  // Pages that remain are read on request wherever the dialog does not read them by itself.
  const byHand = !restricted || tooLarge
  const heads = record.type === 'action' ? record.description.pushedCommits ?? [] : []

  const beneath = (row: PathRow, rows: readonly PathRow[]) =>
    rows.some(other => other !== row && (row.path === '' || other.path.startsWith(`${row.path}/`))) ? 'listed'
      : !review.done && entries.at(-1) === row ? 'loading'
        : 'none'

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog
        size="xl"
        className="!top-1/2 !z-[1200] h-[min(900px,calc(var(--app-height,100dvh)-32px))] !w-[min(1280px,calc(100vw-32px))] !max-w-none !-translate-y-1/2 overflow-hidden bg-kumo-base p-0"
      >
        <div className="flex h-full min-w-0 flex-col">
          <header className="flex max-h-[55%] shrink-0 flex-col border-b border-kumo-line">
            <div className="flex shrink-0 items-start gap-3 py-2.5 pl-4 pr-2.5">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-[15px] font-medium leading-5 tracking-[-0.3px] text-kumo-default">
                  Review commits
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 break-words text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
                  {record.description.title} · {record.resourceTitle}
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={props => (
                  <WorkshopIconButton {...props} aria-label="Close">
                    <XIcon size={16} />
                  </WorkshopIconButton>
                )}
              />
            </div>

            {/* The request can be as long as its gatekeeper made it: it scrolls here, whole, and
                the decision below it stays in view. */}
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 pb-3">
              {request && (
                <p id={requestId} className="m-0 whitespace-pre-wrap break-words text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
                  {request}
                </p>
              )}
              {fields.length > 0 && (
                <div id={fieldsId}><ActionFields fields={fields} uncapped /></div>
              )}
              {restricted && <RestrictedApprovalNotice id={noticeId} />}
              <p className={captionClass}>
                {plural(commitCount, 'commit')}, {plural(pathCount, 'path')},{' '}
                {plural(review.objectCount, 'object')} sent in all{review.done || review.truncated ? '' : ' so far'}.
              </p>
              {review.truncated && <p className={statementClass}>{tooLargeToReview(entries.length)}</p>}
              {review.restarted && (
                <p className={captionClass}>
                  This push changed while it was being read, so it was read again from the start.
                </p>
              )}
              {review.stackedOn.length > 0 && (
                <p className={statementClass}>
                  This push also sends what {review.stackedOn.length === 1 ? 'request' : 'requests'}{' '}
                  {requestList(review.stackedOn)} would send, which{' '}
                  {review.stackedOn.length === 1 ? 'is' : 'are'} still waiting. Denying{' '}
                  {review.stackedOn.length === 1 ? 'that request' : 'those requests'} takes nothing out of
                  this push.
                </p>
              )}
              {restricted && unshown > 0 && (
                <p className={statementClass}>
                  {unshown === 1 ? '1 thing this push sends is' : `${unshown} things this push sends are`} not
                  shown as text; each says why. A push holds such things only when it was already waiting
                  before this workspace read restricted data.
                </p>
              )}
            </div>

            {restricted && (
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-kumo-line px-4 py-2">
                <p id={readinessId} role="status" className={`min-w-[12rem] flex-1 ${captionClass}`}>
                  {readiness.ready
                    ? `The whole review has loaded: ${plural(commitCount, 'commit')} and ${plural(files.total, 'file')}.`
                    : readiness.reason}
                </p>
                {help && <WorkshopButton onClick={help.run}>{help.label}</WorkshopButton>}
                <div className="flex items-center gap-1.5">
                  <ResolveButton tone="deny" onClick={onReject} disabled={processing} describedBy={describedBy} />
                  <ResolveButton
                    tone="approve"
                    variant="filled"
                    onClick={onApprove}
                    disabled={processing || !readiness.ready}
                    describedBy={describedBy}
                  />
                </div>
              </div>
            )}
          </header>

          <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
            {!listed ? (
              <div className="grid flex-1 place-items-center p-6">
                {review.error !== undefined ? (
                  <div role="alert" className="flex flex-col items-center gap-2 text-center">
                    <p className="m-0 text-[13px] leading-[18px] text-kumo-danger">{review.error}</p>
                    {!restricted && <WorkshopButton onClick={review.retry}>Retry</WorkshopButton>}
                  </div>
                ) : review.truncated ? (
                  <p className={`max-w-xl ${statementClass}`}>
                    Listing this push takes more than one read of it may: what it sends cannot be shown here.
                  </p>
                ) : !review.done ? (
                  <Loader aria-label="Loading the review" />
                ) : (
                  <p className={`max-w-xl ${statementClass}`}>
                    This push sends no objects: the remote already has{' '}
                    <span className="font-mono">{heads.map(shortOid).join(', ')}</span>. Approving it only moves
                    the branch to that commit.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-kumo-line md:max-h-none md:w-[320px] md:border-b-0 md:border-r">
                  <PushReviewList
                    items={items}
                    selectedKey={selected?.key}
                    onSelect={select}
                    problemOf={row => {
                      const state = restricted ? files.stateOf(row) : 'idle'
                      return typeof state !== 'object' ? undefined
                        : 'failed' in state ? 'could not be read'
                          : 'mismatch' in state ? 'not as listed'
                            : undefined
                    }}
                    more={byHand && !review.done && !review.truncated && review.error === undefined
                      ? { shown: entries.length, loading: review.loading, onLoadMore: review.loadMore }
                      : undefined}
                  />
                  {review.error !== undefined && (
                    <div role="alert" className="flex flex-col items-start gap-1.5 px-4 pb-3">
                      <p className="m-0 text-[12px] leading-4 text-kumo-danger">{review.error}</p>
                      {!restricted && <WorkshopButton onClick={review.retry}>Retry</WorkshopButton>}
                    </div>
                  )}
                </div>
                <section
                  aria-label="The selected commit or file"
                  tabIndex={0}
                  className="min-h-0 min-w-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
                >
                  {selected?.kind === 'commit' ? (
                    <PushReviewCommitView commit={selected.reviewed.commit} />
                  ) : selected?.kind === 'path' ? (
                    <PushReviewFileView
                      key={selected.key}
                      overseer={overseer}
                      commit={selected.reviewed.commit}
                      row={selected.row}
                      beneath={beneath(selected.row, selected.reviewed.paths)}
                      state={files.stateOf(selected.row)}
                      onRequest={() => files.request(selected.row)}
                      onRetry={files.retry}
                    />
                  ) : selected && (
                    <div className="flex flex-col gap-2 p-4">
                      <p className={statementClass}>Sent, but no commit of this push shows it at a path.</p>
                      <p className="m-0 break-all font-mono text-[12px] leading-[18px] text-kumo-default">
                        {selected.row.type} {selected.row.oid}
                      </p>
                      <p className={statementClass}>
                        {selected.row.size === undefined ? 'Not in this workspace yet.' : formatSize(selected.row.size)}
                      </p>
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
