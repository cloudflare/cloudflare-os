import { useId, type ReactElement, type ReactNode } from 'react'
import { Tooltip as BaseTooltip } from '@cloudflare/kumo/primitives/tooltip'

/** Kumo's ready-made tooltip cannot set the positioner's z-index above floating chat surfaces. */
export const Tooltip = ({ content, children }: { content: ReactNode; children: ReactElement }) => {
  const id = useId()

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} aria-describedby={id} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={8} collisionPadding={12} className="z-50 max-w-[min(var(--available-width),20rem)]">
          <BaseTooltip.Popup id={id} role="tooltip" className="origin-[var(--transform-origin)] rounded-lg bg-kumo-base px-2.5 py-1.5 text-xs/4 wrap-anywhere text-kumo-default ring-1 ring-kumo-line transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
