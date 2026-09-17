import type { MouseEventHandler } from 'react'

export function ResolveButton({
  tone,
  variant = 'quiet',
  disabled,
  onClick,
  describedBy,
}: {
  tone: 'approve' | 'deny'
  variant?: 'quiet' | 'filled'
  disabled: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
  /**
   * Ids of the review text this decision rests on (the restricted-mode notice and the request),
   * so screen readers announce it on focus even though it follows the button in DOM order.
   */
  describedBy?: string
}) {
  const toneClassName = variant === 'filled'
    ? 'h-7 bg-kumo-brand px-3 text-white enabled:hover:opacity-90'
    : tone === 'approve'
      ? 'h-6 px-2 text-kumo-default enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default-hover'
      : 'h-6 px-2 text-kumo-inactive enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className={`flex cursor-pointer items-center rounded-md text-[12px] font-medium tracking-[-0.15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClassName}`}
    >
      {tone === 'approve' ? 'Approve' : 'Deny'}
    </button>
  )
}

export function AlwaysApproveButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
    >
      Always approve
    </button>
  )
}
