import { useId, type ReactElement, type ReactNode } from 'react'
import { Tooltip as BaseTooltip } from '@cloudflare/kumo/primitives/tooltip'

export type TooltipProps = {
  content: ReactNode
  side?: 'top' | 'right'
  /**
   * How long it is pointed at before the tooltip shows, in milliseconds. Left out, the wait is long
   * enough that a pointer only passing over shows nothing; shorter is for what is pointed at to be
   * told about, such as a picture with no text of its own.
   */
  delay?: number
  children: ReactElement
}

/** Kumo's ready-made tooltip cannot set the positioner's z-index above floating chat surfaces. */
export const Tooltip = ({ content, side = 'top', delay, children }: TooltipProps) => {
  const id = useId()

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} aria-describedby={id} delay={delay} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={8} collisionPadding={12} className="z-50 max-w-[min(var(--available-width),20rem)]">
          <BaseTooltip.Popup id={id} role="tooltip" className="origin-[var(--transform-origin)] rounded-lg bg-kumo-base px-2.5 py-1.5 text-xs/4 wrap-anywhere text-kumo-default ring-1 ring-kumo-line transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
