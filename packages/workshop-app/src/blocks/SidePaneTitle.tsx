import type { ReactElement } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type SidePaneTitleProps = {
  title: string
  /** What kind of thing it is, before its name. */
  icon?: ReactElement
}

/** The name of what is shown in the side pane, as a bubble shaped like a button. */
export const SidePaneTitle = ({ title, icon }: SidePaneTitleProps) => (
  <span className={cn('inline-flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base pe-(--control-pad) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line', icon ? 'ps-(--control-pad-icon)' : 'ps-(--control-pad)')}>
    {icon && <span className="me-2 flex shrink-0 text-kumo-subtle [&>svg]:size-[1.125em]">{icon}</span>}
    <span className="truncate">{title}</span>
  </span>
)
