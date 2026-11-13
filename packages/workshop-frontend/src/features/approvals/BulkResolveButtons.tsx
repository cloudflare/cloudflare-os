const buttonClass =
  'flex h-7 flex-shrink-0 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium ' +
  'tracking-[-0.15px] transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40'

/**
 * Resolve a set of pending requests together: the pair in the tray's header, and again in the
 * footer of an opened group.
 *
 * One definition rather than two, because the labels are the only summary the user gets of what a
 * click is about to send, and a second copy drifts — these had already diverged by a few pixels of
 * height.
 *
 * Quiet on purpose. They send real and mostly irreversible effects to someone else's service,
 * while the filled primary in this slot belongs to the code draft's local, reversible accept.
 */
export const BulkResolveButtons = ({
  count,
  disabled,
  onDiscardAll,
  onApplyAll,
}: {
  /** How many requests "Apply all" would send, which the label names. */
  count: number
  disabled: boolean
  onDiscardAll: () => void
  onApplyAll: () => void
}) => (
  <>
    <button
      type="button"
      onClick={onDiscardAll}
      disabled={disabled}
      className={`${buttonClass} text-kumo-inactive enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger`}
    >
      Discard all
    </button>
    <button
      type="button"
      onClick={onApplyAll}
      disabled={disabled}
      className={`${buttonClass} text-kumo-default enabled:hover:bg-kumo-tint`}
    >
      Apply all {count}
    </button>
  </>
)
