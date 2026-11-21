import { Popover, Tooltip } from '@cloudflare/kumo'
import { Crosshair, X } from '@phosphor-icons/react'
import { focusLabel, type TitledFocus } from './paneFocus'

/**
 * A sent chip's tooltip: its heading, then the spot's context (what the agent was told is there) as
 * plain text, clamped so a long quote doesn't fill the screen.
 */
const FocusTooltip = ({ heading, context }: { heading: string; context: string | undefined }) =>
  context
    ? (
      <span className="block max-w-xs">
        <span className="block break-words">{heading}</span>
        {/* No `block` here: it would outrank the `-webkit-box` that line-clamp needs. The explicit
            leading keeps the clamp's reserved height a whole number of rendered lines. */}
        <span className="mt-1 line-clamp-6 whitespace-pre-line break-words leading-[18px] text-kumo-subtle">
          {context}
        </span>
      </span>
    )
    : heading

const CHIP_CLASS =
  'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-elevated text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle'

/**
 * What a message tells the agent the user was focused on. In the composer it can be dismissed for
 * the message being written; on a sent message it opens the gadget at that spot.
 */
export const FocusChip = (props: { focus: TitledFocus } & (
  | { onOpen: () => void }
  | { onDismiss: () => void; disabled?: boolean }
)) => {
  const label = focusLabel(props.focus)
  const context = props.focus.spot?.context
  const face = (
    <>
      <Crosshair size={12} aria-hidden="true" className="shrink-0 text-kumo-inactive" />
      <span className="truncate">{label}</span>
    </>
  )

  if ('onOpen' in props) {
    return (
      <Tooltip content={<FocusTooltip heading={label} context={context} />} side="top" asChild>
        <button
          type="button"
          onClick={props.onOpen}
          aria-label={`Show ${label}`}
          className={`${CHIP_CLASS} cursor-pointer px-2.5 py-1 transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring`}
        >
          {face}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className={`${CHIP_CLASS} py-0.5 pl-2.5 pr-0.5`}>
      {/* A popover rather than a tooltip: the context it shows is the only preview of what the
          message will carry, and a tap never opens a tooltip. */}
      <Popover>
        <Popover.Trigger
          openOnHover
          render={
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              {face}
            </button>
          }
        />
        <Popover.Content
          side="top"
          sideOffset={8}
          positionMethod="fixed"
          className="themed-floating-shadow !z-[1100] !w-auto !min-w-0 !max-w-[min(20rem,calc(100vw-24px))] rounded-xl border border-kumo-line bg-kumo-base !px-3 !py-2 text-[12px] leading-[18px] text-kumo-default !outline-none [&>:first-child]:hidden"
        >
          <Popover.Title className="block break-words text-[12px] font-normal leading-[18px] text-kumo-default">
            The agent will be told you're viewing {label}
          </Popover.Title>
          {/* Scrolled rather than clamped, since this is where the user checks what will be sent. */}
          {context && (
            <Popover.Description className="mt-1 max-h-[min(40vh,15rem)] overflow-y-auto whitespace-pre-line break-words text-[12px] leading-[18px] text-kumo-subtle">
              {context}
            </Popover.Description>
          )}
        </Popover.Content>
      </Popover>
      <button
        type="button"
        onClick={props.onDismiss}
        disabled={props.disabled}
        aria-label={`Don't send ${label} with this message`}
        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X size={10} weight="bold" />
      </button>
    </div>
  )
}
