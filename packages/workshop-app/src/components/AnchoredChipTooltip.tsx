import { useState } from 'react'
import { Tooltip } from '@cloudflare/kumo/primitives/tooltip'
import { ChipTooltipCard, type ChipAbout } from './ChipTooltip'

/**
 * A chip's card (`ChipTooltip`) over something that is not React's to wrap, such as a pill in a
 * draft's editor: shown for as long as it is told what to say and over what (`shown`, the same
 * object for as long as it is the same thing), by whoever knows what is pointed at, who waits
 * `CHIP_TOOLTIP_DELAY` first, and is told as the pointer comes onto a card that is a link and
 * leaves it (`onPointer`).
 */
export const AnchoredChipTooltip = ({ shown, onPointer }: { shown?: { about: ChipAbout; anchor: Element }; onPointer?: (over: boolean) => void }) => {
  // It stays where it is, saying what it said, while it closes.
  const [last, setLast] = useState(shown)
  if (shown && shown !== last) setLast(shown)
  return (
    // A link's card can be gone onto, to go to the link.
    <Tooltip.Root open={shown !== undefined} disableHoverablePopup={last?.about.href === undefined}>
      <Tooltip.Portal>{last && <ChipTooltipCard about={last.about} anchor={last.anchor} onPointer={onPointer} />}</Tooltip.Portal>
    </Tooltip.Root>
  )
}
