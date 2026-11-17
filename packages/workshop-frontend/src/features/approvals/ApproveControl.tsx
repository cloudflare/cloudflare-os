import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { ResolveButton } from '../../components/ResolveButton'
import { isPush, reviewsBeforeApproving } from './pushApproval'

const reviewButtonClass = 'flex cursor-pointer items-center whitespace-nowrap rounded-md text-[12px] font-medium tracking-[-0.15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const quietClass = 'h-6 px-2 text-kumo-default enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default-hover'
const filledClass = 'h-7 bg-kumo-brand px-3 text-white enabled:hover:opacity-90'

/**
 * What stands where a pending request is approved, on every surface that decides one.
 *
 * A push's description is a summary of commits it does not show, so a push also offers "Review
 * commits", which opens them. In a workspace that holds restricted data the approver vouches for
 * what they read, so there the review is the only way in and carries Approve itself: this
 * renders "Review commits" alone, in Approve's place and style.
 */
export const ApproveControl = ({ record, restricted, variant = 'quiet', disabled, describedBy, onApprove, onReviewPush }: {
  record: ActionLogEntry
  /** The workspace holds restricted data; `undefined` while that is not known yet. */
  restricted: boolean | undefined
  variant?: 'quiet' | 'filled'
  disabled: boolean
  /** Ids of the review text the decision rests on (see ResolveButton). */
  describedBy?: string
  onApprove: () => void
  onReviewPush: () => void
}) => {
  const approve = (
    <ResolveButton tone="approve" variant={variant} disabled={disabled} onClick={onApprove} describedBy={describedBy} />
  )
  if (!isPush(record)) return approve
  const reviewOnly = reviewsBeforeApproving(record, restricted)
  return (
    <>
      <button
        type="button"
        onClick={onReviewPush}
        disabled={disabled}
        aria-describedby={describedBy}
        className={`${reviewButtonClass} ${reviewOnly && variant === 'filled' ? filledClass : quietClass}`}
      >
        Review commits
      </button>
      {!reviewOnly && approve}
    </>
  )
}
