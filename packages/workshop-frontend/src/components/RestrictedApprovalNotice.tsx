import { ShieldWarning } from '@phosphor-icons/react'

/**
 * What an approver is told before approving an action in a workspace that has read restricted
 * data: the kernel does not check the action for that data, the approver does.
 */
export const RESTRICTED_APPROVAL_COPY =
  'This workspace has read sensitive data. Read the full request below before approving — you ' +
  'are responsible for making sure it contains none of that data.'

/**
 * Shown once above each connection's batch in the Activity review pane, the only surface that
 * approves actions, while the workspace is restricted. The pane renders every row's description
 * and fields untruncated beneath it, since the notice asks the approver to read all of it.
 */
export function RestrictedApprovalNotice({ id, className = '' }: { id?: string, className?: string }) {
  return (
    <div
      id={id}
      role="note"
      className={`flex items-start gap-2.5 rounded-2xl bg-kumo-warning-tint px-3 py-2.5 ${className}`}
    >
      <div className="grid h-6 w-6 shrink-0 place-items-center text-kumo-warning">
        <ShieldWarning size={18} weight="duotone" />
      </div>
      <p className="m-0 text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-default">
        {RESTRICTED_APPROVAL_COPY}
      </p>
    </div>
  )
}
