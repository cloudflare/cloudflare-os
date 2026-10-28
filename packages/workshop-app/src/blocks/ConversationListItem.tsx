import { cn } from '@cloudflare/kumo/utils'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export type ConversationListItemProps = {
  workspaceLabel: string
  title: string
  /** The latest message in the conversation. */
  preview: string
  unread?: boolean
  selected?: boolean
}

// The row's tappable area reaches 1px past its edges so the 2px gap Sidebar leaves between rows
// (`gap-0.5`) has no dead strip. Keep this at half of that gap.
const GAP_FILLER = "relative after:absolute after:inset-x-0 after:-inset-y-px after:content-['']"

/** One conversation in the sidebar: its workspace, title, latest message and unread dot. */
export const ConversationListItem = ({
  workspaceLabel,
  title,
  preview,
  unread,
  selected,
}: ConversationListItemProps) => (
  <button
    type="button"
    aria-current={selected || undefined}
    className={cn(
      GAP_FILLER,
      'flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base hover:bg-kumo-fill',
      selected && 'bg-kumo-fill',
    )}
  >
    <WorkspaceIcon label={workspaceLabel} />
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      <span className="block truncate text-kumo-subtle">{preview}</span>
    </span>
    {unread && <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-kumo-brand" />}
  </button>
)
