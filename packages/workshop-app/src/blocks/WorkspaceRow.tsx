import type { ReactNode } from 'react'
import { ArrowSquareOutIcon, DotsThreeIcon, LinkIcon, StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export type WorkspaceRowProps = {
  workspaceLabel: string
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** The workspace's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

const ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'

/**
 * One of the row's buttons at its end, which slides out from under the edge, pushing the time in,
 * while the row is pointed at or has focus, or its menu is open. Always out to a finger, which
 * cannot point, and while `shown`.
 */
const Action = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      // The sidebar underlay's glide (`useWorkspaceUnderlay`), so pointing at a row answers as quickly.
      'flex shrink-0 justify-end transition-[width,opacity] duration-75 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none',
      shown
        ? 'w-10 opacity-100'
        : 'pointer-events-none w-0 opacity-0 group-has-focus-visible:pointer-events-auto group-has-focus-visible:w-10 group-has-focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:w-10 group-hover:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:w-10 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:w-10 pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/**
 * One workspace on the Workspaces page, on one line: its icon and title, and when it was last
 * active at the far end. Pointed at, more and its star slide out at the end; a starred one keeps
 * its star out. The star is last, so it stays where it is as more slides out before it.
 */
export const WorkspaceRow = ({ workspaceLabel, title, time, starred, onStarredChange, href, onSelect }: WorkspaceRowProps) => (
  <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole row opens the workspace, apart from the buttons over it.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
    >
      <WorkspaceIcon label={workspaceLabel} />
      <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
      {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
    </LinkButton>
    {href && (
      <Action>
        <span className="relative flex">
          <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={ACTION} align="end">
            <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => window.open(href, '_blank', 'noopener')}>Open in new tab</DropdownMenu.Item>
            <DropdownMenu.Item icon={LinkIcon} onSelect={() => copyLink(href)}>Copy link</DropdownMenu.Item>
          </DropdownMenu>
        </span>
      </Action>
    )}
    <Action shown={starred}>
      <Button
        variant="ghost"
        icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
        aria-label={`Star ${title}`}
        aria-pressed={starred}
        onClick={() => onStarredChange(!starred)}
        className={cn('relative', ACTION)}
      />
    </Action>
  </div>
)
