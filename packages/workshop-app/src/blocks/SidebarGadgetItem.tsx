import { cn } from '@cloudflare/kumo/utils'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'

export type SidebarGadgetItemProps = {
  title: string
  /** What it is, as its format names it ("Document"), or an app: read out, as its icon shows it. */
  noun?: string
  icon?: FormatIconName
  /** How many things it asks that wait on the viewer, counted at the end of its line. */
  waiting?: number
  /** It is on screen: beside the page, or as its own. */
  current?: boolean
  /** Its own page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One gadget in the sidebar, on one line, quieter than a chat's: its format's icon on a small tile,
 * in line with the chats' marks, its title, and how much it asks that waits on the viewer. Filled
 * by the list's shared highlight (`data-sidebar-row`).
 */
export const SidebarGadgetItem = ({ title, noun = 'App', icon, waiting = 0, current = false, href, onSelect }: SidebarGadgetItemProps) => (
  <LinkButton
    href={href}
    data-sidebar-row="gadget"
    onClick={onSelect}
    aria-current={current ? 'page' : undefined}
    aria-label={`${title}, ${noun}${waiting > 0 ? `, ${waiting} waiting on you` : ''}`}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-base not-data-underlay:hover:bg-kumo-fill',
      current && 'not-data-underlay:bg-kumo-fill',
    )}
  >
    <span aria-hidden="true" className="grid w-8 shrink-0 place-items-center">
      <span className="grid size-6 place-items-center rounded-md bg-kumo-fill text-kumo-subtle ring-1 ring-kumo-line">
        <FormatIcon name={icon} className="size-3.5" />
      </span>
    </span>
    <span className="min-w-0 flex-1 truncate text-kumo-default">{title}</span>
    {waiting > 0 && (
      <span aria-hidden="true" className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-kumo-warning-tint px-1.5 text-xs/none font-medium text-kumo-default tabular-nums">
        {waiting > 99 ? '99+' : waiting}
      </span>
    )}
  </LinkButton>
)
