import { useId } from 'react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { ActionFields, entryFields } from '../../../components/ActionFields'
import {
  IncompleteDescriptionNotice, isDescriptionIncomplete,
} from '../../../components/IncompleteDescriptionNotice'
import { ResolveButton } from '../../../components/ResolveButton'
import { RestrictedApprovalNotice } from '../../../components/RestrictedApprovalNotice'
import { safeExternalUrl } from '../../../utils/safeExternalUrl'

/**
 * A request blocking one run, shown where the agent list sends the user: in full, and decidable
 * on the spot.
 *
 * The whole description and every field are here rather than summarised, because approving is
 * the one action whose whole point is knowing what you are agreeing to. The card scrolls instead
 * of clamping each field, so there is one scrollbar to find rather than one per field.
 *
 * The notices sit above the description: they are the things a reader who does not scroll must
 * still see. A restricted workspace gets the same warning here as every other approve surface --
 * the kernel does not check the action for the sensitive data this workspace has read, so the
 * person approving from the agent list is the only one who will.
 *
 * Deciding is the surrounding surface's job, not the card's: approving a creation opens a modal,
 * which must outlive a popover that closes the moment the modal takes the click.
 */
export const PendingApprovalCard = ({ record, restricted, busy, onResolve }: {
  record: ActionLogEntry
  /** The workspace has read restricted data, making the approver responsible for what leaves. */
  restricted: boolean
  /** True while this record's decision is in flight. */
  busy: boolean
  onResolve: (decision: 'approve' | 'deny') => void
}) => {
  const reviewId = useId()
  const requestId = `${reviewId}-request`
  const fieldsId = `${reviewId}-fields`
  const incompleteId = `${reviewId}-incomplete`
  const restrictedId = `${reviewId}-restricted`
  const fields = entryFields(record)
  const incomplete = isDescriptionIncomplete(record)
  const resourceUrl = safeExternalUrl(record.resourceUrl)
  // Everything the decision rests on follows the buttons in DOM order, so name it explicitly.
  const describedBy = [
    ...(restricted ? [restrictedId] : []),
    ...(incomplete ? [incompleteId] : []),
    ...(record.description.description ? [requestId] : []),
    ...(fields.length > 0 ? [fieldsId] : []),
  ].join(' ') || undefined

  return (
    <article className="shrink-0 overflow-hidden rounded-xl border border-kumo-warning/40 bg-kumo-warning-tint/30">
      <header className="px-3.5 pb-1.5 pt-3">
        <h3 className="m-0 text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
          {record.description.title}
        </h3>
        <p className="mt-0.5 truncate text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
          {resourceUrl ? (
            <a
              href={resourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-kumo-default hover:underline"
            >
              {record.resourceTitle}
            </a>
          ) : record.resourceTitle}
        </p>
      </header>

      <div className="max-h-[340px] overflow-y-auto px-3.5 pb-2">
        {restricted && <RestrictedApprovalNotice id={restrictedId} className="mb-2" />}
        {incomplete && <IncompleteDescriptionNotice id={incompleteId} className="mb-2" />}
        {record.description.description && (
          <p
            id={requestId}
            className="whitespace-pre-wrap text-[12.5px] leading-[18px] tracking-[-0.2px] text-kumo-subtle"
          >
            {record.description.description}
          </p>
        )}
        {fields.length > 0 && (
          <div id={fieldsId}>
            <ActionFields fields={fields} uncapped className="mt-2" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-0.5 border-t border-kumo-warning/30 px-2 py-1.5">
        <ResolveButton
          tone="deny"
          onClick={() => onResolve('deny')}
          disabled={busy}
          describedBy={describedBy}
        />
        <ResolveButton
          tone="approve"
          variant="filled"
          onClick={() => onResolve('approve')}
          disabled={busy}
          describedBy={describedBy}
        />
      </div>
    </article>
  )
}
