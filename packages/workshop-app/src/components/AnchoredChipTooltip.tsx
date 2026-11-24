import { useState } from 'react'
import { Tooltip } from '@cloudflare/kumo/primitives/tooltip'
import { ChipTooltipCard, type ChipAbout } from './ChipTooltip'

/**
 * A chip's card (`ChipTooltip`) over something that is not React's to wrap, such as a pill in a
 * draft's editor: shown for as long as it is told what to say and over what (`shown`, the same
 * object for as long as it is the same thing), by whoever knows what is pointed at, who waits
 * `CHIP_TOOLTIP_DELAY` first.
 */
export const AnchoredChipTooltip = ({ shown }: { shown?: { about: ChipAbout; anchor: Element } }) => {
  // It stays where it is, saying what it said, while it closes.
  const [last, setLast] = useState(shown)
  if (shown && shown !== last) setLast(shown)
  return (
    <Tooltip.Root open={shown !== undefined} disableHoverablePopup>
      <Tooltip.Portal>{last && <ChipTooltipCard about={last.about} anchor={last.anchor} />}</Tooltip.Portal>
    </Tooltip.Root>
  )
}
