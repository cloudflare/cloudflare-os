import { useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { WorkspaceListItem, type WorkspaceListItemProps } from './WorkspaceListItem'
import { WorkspaceRailItem } from './WorkspaceRailItem'
import { useScrollFadeFallback } from '@gadgets/ui'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

export type SidebarWorkspace = Omit<WorkspaceListItemProps, 'selected' | 'onSelect'> & { id: string }

export type WorkspaceNavProps = {
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** Shown in place of the list when there is nothing to list. Not on the rail, which has no room. */
  notice?: string
  /** Each workspace is its icon alone, on the collapsed sidebar's rail. */
  rail?: boolean
  /** What scrolls fades out at either end while there is more that way (`.sidebar-fade`). */
  fades?: boolean
}

/**
 * The sidebar's workspaces, with one highlight shared between the selected row and the one
 * pointed at (see `useWorkspaceUnderlay`). Give it a `key` that changes with `rail`: the
 * highlight measures the rows it started with.
 */
export const WorkspaceNav = ({ workspaces, selectedWorkspaceId, onSelectWorkspace, notice, rail = false, fades = false }: WorkspaceNavProps) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay()
  const scrollRef = useRef<HTMLElement>(null)
  useScrollFadeFallback(scrollRef)
  const Item = rail ? WorkspaceRailItem : WorkspaceListItem
  // On the rail, a tint of the text colour: black at 8%, white in dark mode.
  const underlay = cn('pointer-events-none absolute inset-x-0 top-0 -z-10 h-0', rail ? 'rounded-xl bg-kumo-contrast/8' : 'rounded-2xl bg-kumo-fill')

  return (
    // Scrolled with no scrollbar, expanded or on the rail, with room around it for the rows' focus rings, which scrolling would clip.
    <nav ref={scrollRef} aria-label="Workspaces" className={cn('-mx-1 -my-1 flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto p-1 [scrollbar-width:none]', fades && 'chat-fade sidebar-fade')}>
      <div ref={listRef} className="relative isolate flex shrink-0 flex-col">
        <div ref={underlayRef} aria-hidden="true" className={underlay} />
        <div ref={hoverUnderlayRef} aria-hidden="true" className={underlay} />
        {workspaces.map(({ id, ...workspace }) => (
          <Item
            key={id}
            id={id}
            {...workspace}
            selected={id === selectedWorkspaceId}
            onSelect={() => onSelectWorkspace(id)}
          />
        ))}
      </div>
      {notice && !rail && <p className="px-3 py-2 text-base text-kumo-subtle">{notice}</p>}
    </nav>
  )
}
