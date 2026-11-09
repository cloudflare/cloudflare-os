import { cn } from '@cloudflare/kumo/utils'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export type ConversationListItemProps = {
  workspaceLabel: string
  title: string
  /** A line under the title: the latest message, or when the conversation was last active. */
  subtitle?: string
  unread?: boolean
  selected?: boolean
  onSelect: () => void
}

// The row's tappable area reaches 1px past its edges so the 2px gap Sidebar leaves between rows
// (`gap-0.5`) has no dead strip. Keep this at half of that gap.
const GAP_FILLER = "relative after:absolute after:inset-x-0 after:-inset-y-px after:content-['']"

// Rows touch, so two highlighted neighbours (the selected one, the hovered one) read as one shape:
// the corners where they meet square off, and the radius transitions as the highlight moves.
// Written out in full because Tailwind only picks up class names it can read as literal strings.
const CONNECTED =
  'transition-[border-radius] motion-reduce:transition-none ' +
  '[&:is([aria-current],:hover):has(+:is([aria-current],:hover))]:rounded-b-none ' +
  '[:is([aria-current],:hover)+&:is([aria-current],:hover)]:rounded-t-none'

/** One conversation in the sidebar: its workspace, title, subtitle and unread dot. */
export const ConversationListItem = ({
  workspaceLabel,
  title,
  subtitle,
  unread,
  selected,
  onSelect,
}: ConversationListItemProps) => (
  <button
    type="button"
    onClick={onSelect}
    aria-current={selected || undefined}
    className={cn(
      GAP_FILLER,
      CONNECTED,
      'flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base hover:bg-kumo-fill',
      selected && 'bg-kumo-fill',
    )}
  >
    <WorkspaceIcon label={workspaceLabel} />
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      {subtitle && <span className="block truncate text-kumo-subtle">{subtitle}</span>}
    </span>
    {unread && <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-kumo-brand" />}
  </button>
)
