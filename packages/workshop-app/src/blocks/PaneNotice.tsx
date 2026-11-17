import type { Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'

export type PaneNoticeProps = {
  /** Left out for something under way, which is held back a moment, as most are soon over. */
  icon?: Icon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

/** What a pane says in place of what it shows: that it is loading, that there is nothing, that it failed. */
export const PaneNotice = ({ icon: Glyph, title, description, action }: PaneNoticeProps) => (
  <div className={cn('flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center', Glyph ? 'appears' : 'appears-late')}>
    {Glyph && (
      <span className="grid size-12 place-items-center rounded-2xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
        <Glyph aria-hidden="true" className="size-6" />
      </span>
    )}
    <div className="flex max-w-xs flex-col gap-1">
      <p className="text-base font-medium text-kumo-default">{title}</p>
      {description && <p className="text-sm text-kumo-subtle">{description}</p>}
    </div>
    {action && <Button onClick={action.onClick}>{action.label}</Button>}
  </div>
)
