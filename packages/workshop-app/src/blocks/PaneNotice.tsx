import type { Icon } from '@/components/icons'
import { EmptyState } from '@gadgets/ui'

export type PaneNoticeProps = {
  /** Left out for something under way, which is held back a moment, as most are soon over. */
  icon?: Icon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  /** On a tinted surface, such as the side pane's (`EmptyState`'s `onTint`). */
  onTint?: boolean
}

/** What a pane says in place of what it shows: that it is loading, that there is nothing, that it failed. */
export const PaneNotice = ({ icon, title, description, action, onTint = false }: PaneNoticeProps) => (
  <div className="flex flex-1 flex-col items-center justify-center p-2">
    {icon
      ? <EmptyState size="section" onTint={onTint} icon={icon} title={title} description={description} actions={action && [action]} />
      : <p role="status" className="appears-late p-6 text-base font-medium text-kumo-default">{title}</p>}
  </div>
)
