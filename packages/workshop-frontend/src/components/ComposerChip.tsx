import { X } from '@phosphor-icons/react'

/**
 * One value staged in a chip composer, such as a person the Share dialog will invite: its label,
 * an optional monospaced detail beside it, and a button that removes it.
 */
export const ComposerChip = ({ label, detail, title, error = false, removeLabel, disabled, onRemove }: {
  label: string
  /** Shown monospaced after the label, such as the id a person's name stands for. */
  detail?: string
  title?: string
  /** Marks the chip as one whose value was refused. */
  error?: boolean
  /** The remove button's accessible name. */
  removeLabel: string
  disabled?: boolean
  onRemove: () => void
}) => (
  <span
    title={title}
    className={`inline-flex max-w-full items-center gap-1 rounded-full border py-[3px] pl-2.5 pr-1 text-[11px] leading-4 font-medium tracking-[-0.1px] ${
      error
        ? 'border-kumo-danger bg-kumo-danger-tint/40 text-kumo-danger'
        : 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
    }`}
  >
    <span className="truncate">{label}</span>
    {detail !== undefined && (
      <span className="truncate font-mono text-[10px] text-kumo-subtle">{detail}</span>
    )}
    <button
      type="button"
      aria-label={removeLabel}
      onClick={onRemove}
      disabled={disabled}
      className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed"
    >
      <X size={10} weight="bold" />
    </button>
  </span>
)
