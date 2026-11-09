import { CaretRightIcon, EyeIcon, XIcon } from '@phosphor-icons/react'

type Props = {
  /** After a refused check the card says what's missing instead of offering the check again. */
  checked: boolean
  ownerName: string
  /** When the view was taken, aged ("today, 10:42"). */
  moment: string
  onOpen: () => void
  onDismiss: () => void
}

/**
 * Floats over the top of a shared view, in the shape of the Workshop's "same kind of app?" card,
 * the whole card being the one button: what this is (a snapshot of what the owner sees), when it
 * was taken, and what using the gadget takes. It speaks of using the gadget, never of data, since
 * a gadget can be anything; the dialog behind it does the connecting. Hiding it leaves the header
 * chip, which brings it back.
 */
const ExploreCard = ({ checked, ownerName, moment, onOpen, onDismiss }: Props) => {
  const title = `A snapshot of what ${ownerName} sees`
  const subtitle = checked
    ? `From ${moment}. You don't have access to use it yet.`
    : `From ${moment}. Sign in to use it live.`
  return (
    <div className="flex w-full items-center rounded-2xl border border-kumo-line bg-kumo-elevated shadow-lg">
      <button
        type="button"
        onClick={onOpen}
        // Title and subtitle as sentences; the spans alone would run them together.
        aria-label={`${title}. ${subtitle}`}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl py-2.5 pl-2.5 pr-1 text-left"
      >
        <span aria-hidden className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-kumo-tint text-kumo-default">
          <EyeIcon size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium leading-5 text-kumo-default">{title}</span>
          <span className="text-[13px] leading-5 text-kumo-subtle">{subtitle}</span>
        </span>
        <CaretRightIcon
          aria-hidden
          size={16}
          className="shrink-0 text-kumo-subtle transition-transform group-hover:translate-x-0.5"
        />
      </button>
      <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-kumo-line" />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hide"
        title="Hide"
        className="mr-2 grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}

export default ExploreCard
