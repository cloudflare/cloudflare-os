import type { ReactElement } from 'react'
import { ArrowRight01Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'

export type SidePaneTitleProps = {
  title: string
  /** What kind of thing it is, before its name. */
  icon?: ReactElement
  /** Opens its settings, from the whole bubble, which then ends in a chevron as a chat's title does. */
  onOpenSettings?: () => void
}

const icon = (element: ReactElement) => <span className="flex shrink-0 [&>svg]:size-[1.125em]">{element}</span>

const BUBBLE = 'inline-flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line'

/**
 * The name of what is shown in the side pane, as a bubble shaped like a button. Given a way to its
 * settings, the bubble is a button to them.
 */
export const SidePaneTitle = ({ title, icon: kind, onOpenSettings }: SidePaneTitleProps) => {
  if (onOpenSettings) {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        title="App settings"
        className={cn(
          BUBBLE,
          'cursor-pointer gap-2 pe-(--control-pad) outline-none transition-colors duration-150 hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring',
          kind ? 'ps-(--control-pad-icon)' : 'ps-(--control-pad)',
        )}
      >
        {kind && <span className="flex text-kumo-subtle">{icon(kind)}</span>}
        <span className="truncate">{title}</span>
        <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
      </button>
    )
  }
  return (
    <span className={cn(BUBBLE, kind ? 'ps-(--control-pad-icon) pe-(--control-pad)' : 'px-(--control-pad)')}>
      {kind && <span className="me-2 flex text-kumo-subtle">{icon(kind)}</span>}
      <span className="truncate">{title}</span>
    </span>
  )
}
