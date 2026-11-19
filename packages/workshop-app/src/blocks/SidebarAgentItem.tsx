import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { AgentMark } from './AgentMark'

export type SidebarAgentItemProps = {
  name: string
  /** How it stands, in a word or two at the end of its line: "Working…", "2 waiting", "3 runs". */
  status: string
  /** What `status` says wants the viewer, and is in the colour of something to look at. */
  wantsAttention?: boolean
  /** One of its runs is at work, which its mark shows by thinking. */
  working?: boolean
  /** Its latest run failed, which its mark shows. */
  failed?: boolean
  /** It is on screen. */
  current?: boolean
  /** Its own page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One agent in the sidebar, on one line as a gadget is: its mark, in line with the chats', thinking
 * while one of its runs works and sad once its latest failed; its name; and how it stands. Filled
 * by the list's shared highlight (`data-sidebar-row`).
 */
export const SidebarAgentItem = ({ name, status, wantsAttention = false, working = false, failed = false, current = false, href, onSelect }: SidebarAgentItemProps) => (
  <LinkButton
    href={href}
    data-sidebar-row=""
    onClick={onSelect}
    aria-current={current ? 'page' : undefined}
    aria-label={`${name}, ${status}`}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-base not-data-underlay:hover:bg-kumo-fill',
      current && 'not-data-underlay:bg-kumo-fill',
    )}
  >
    <span aria-hidden="true" className="grid w-8 shrink-0 place-items-center">
      <AgentMark state={working ? 'working' : failed ? 'failed' : 'idle'} size="small" className="size-6" />
    </span>
    <span className="min-w-0 flex-1 truncate text-kumo-default">{name}</span>
    <span aria-hidden="true" className={cn('shrink-0 text-sm', wantsAttention ? 'text-kumo-warning' : 'text-kumo-subtle')}>{status}</span>
  </LinkButton>
)
