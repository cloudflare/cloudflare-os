import { useId } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { ActionFields, entryFields, fieldCountLabel } from '../../components/ActionFields'
import {
  IncompleteDescriptionNotice, isDescriptionIncomplete,
} from '../../components/IncompleteDescriptionNotice'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { AlwaysApproveButton, ResolveButton } from '../../components/ResolveButton'
import { safeExternalUrl } from '../../utils/safeExternalUrl'
import { formatRelativeTime } from '../../utils/formatRelativeTime'

const titleClass = 'm-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default'

/**
 * One pending request, with everything its approver has to read and the decision itself.
 *
 * Shared by every surface that asks for a decision rather than merely reporting one, so the
 * restricted-mode rules live in one place: the description and fields are shown in full and
 * uncapped, the notice explains that the approver is the leak check, and the buttons name that
 * review text through `aria-describedby` even though it follows them in DOM order.
 *
 * The controls sit in the header rather than below the body. That keeps them in view however
 * tall the request is — a single `json` field can run past a viewport — so a surface embedding
 * this only has to make its own container scroll.
 */
export function ReviewRequest({
  record,
  restricted,
  expanded,
  processing,
  showResource = true,
  onToggle,
  decide,
}: {
  record: ActionLogEntry
  /**
   * While restricted the approver is the leak check, so the request is shown in full with a
   * notice saying so.
   */
  restricted?: boolean
  expanded: boolean
  processing: boolean
  /** Off where the surface already names the resource, as a grouped tray does. */
  showResource?: boolean
  onToggle: () => void
  decide: {
    onApprove: () => void
    onReject: () => void
    onAlwaysApprove?: () => void
  }
}) {
  const resourceUrl = safeExternalUrl(record.resourceUrl)
  const fields = entryFields(record)
  // The notices and the request follow the controls in DOM order, so while restricted the
  // approve/deny buttons name them as their description and a screen reader hears the review
  // text on focus.
  const reviewId = useId()
  const noticeId = `${reviewId}-notice`
  const requestId = `${reviewId}-request`
  const fieldsId = `${reviewId}-fields`
  const incompleteId = `${reviewId}-incomplete`
  const incomplete = isDescriptionIncomplete(record)
  const describedBy = restricted
    ? [
      noticeId,
      ...(record.description.description ? [requestId] : []),
      ...(fields.length > 0 ? [fieldsId] : []),
      ...(incomplete ? [incompleteId] : []),
    ].join(' ')
    : undefined
  return (
    <article className="border-b border-kumo-line px-5 py-3 transition-colors hover:bg-kumo-elevated/50">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-[8rem] flex-1">
          {restricted ? (
            // Everything expanding would reveal is already shown, so there is no disclosure.
            <h3 className={titleClass}>{record.description.title}</h3>
          ) : (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="flex max-w-full cursor-pointer items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <h3 className={titleClass}>{record.description.title}</h3>
              <CaretRight
                size={12}
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
              />
            </button>
          )}
          <p className="mt-0.5 truncate text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
            {showResource && (
              <>
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
                <span className="px-1">·</span>
              </>
            )}
            {formatRelativeTime(record.createdAt)}
          </p>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
          {decide.onAlwaysApprove && (
            <AlwaysApproveButton onClick={decide.onAlwaysApprove} disabled={processing} />
          )}
          <ResolveButton tone="deny" onClick={decide.onReject} disabled={processing} describedBy={describedBy} />
          <ResolveButton tone="approve" onClick={decide.onApprove} disabled={processing} describedBy={describedBy} />
        </div>
      </div>

      {restricted && <RestrictedApprovalNotice id={noticeId} className="mt-2 max-w-2xl" />}

      {record.description.description && (
        <p id={requestId} className={`mt-1.5 max-w-2xl whitespace-pre-wrap text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle ${restricted || expanded ? '' : 'line-clamp-2'}`}>
          {record.description.description}
        </p>
      )}

      {fields.length > 0 && (restricted || expanded ? (
        <div id={fieldsId}>
          <ActionFields fields={fields} uncapped={restricted} className="mt-2 max-w-2xl" />
        </div>
      ) : (
        <p className="m-0 mt-1 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
          {fieldCountLabel(fields.length)}
        </p>
      ))}

      {incomplete && <IncompleteDescriptionNotice id={incompleteId} className="mt-2 max-w-2xl" />}
    </article>
  )
}
