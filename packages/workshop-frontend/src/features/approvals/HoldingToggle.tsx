import { Tooltip } from '@cloudflare/kumo'
import { HandPalm } from '@phosphor-icons/react'

/**
 * The open chat's holding toggle (see Overseer.setChatHolding()).
 * Named "Hold changes" in both states, as a pressed toggle; the name shows beside the icon only
 * while holding is on, so the header says so at a glance.
 */
export const HoldingToggle = ({ holding, onHoldingChange }: {
  holding: boolean
  onHoldingChange: (holding: boolean) => void
}) => (
  <Tooltip
    content={holding
      ? 'Holding: gadgets opened in this chat keep their requests until its changes are accepted.'
      : 'Hold changes: gadgets opened in this chat keep their requests until its changes are accepted.'}
    asChild
  >
    <button
      type="button"
      aria-pressed={holding}
      onClick={() => onHoldingChange(!holding)}
      className={`inline-flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-[12px] font-medium leading-4 tracking-[-0.2px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
        holding
          ? 'bg-kumo-tint px-2 text-kumo-default hover:bg-kumo-fill'
          : 'w-8 justify-center text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default'
      }`}
    >
      <HandPalm size={13} weight={holding ? 'fill' : 'regular'} aria-hidden="true" />
      <span className={holding ? undefined : 'sr-only'}>Hold changes</span>
    </button>
  </Tooltip>
)
