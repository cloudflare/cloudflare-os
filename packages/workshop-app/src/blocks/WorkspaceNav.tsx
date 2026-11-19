import { useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretRightIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { WorkspaceListItem, type WorkspaceListItemProps } from './WorkspaceListItem'
import { WorkspaceRailItem } from './WorkspaceRailItem'
import { useScrollFadeFallback } from './useScrollFadeFallback'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

export type SidebarWorkspace = Omit<WorkspaceListItemProps, 'selected' | 'onSelect' | 'withToggle'> & { id: string }

/** Each workspace's chats, under it, opened and closed by a caret at the end of its row. */
export type SidebarWorkspaceChatsSlot = {
  isExpanded: (workspaceId: string) => boolean
  onToggle: (workspaceId: string) => void
  /** What is under an expanded workspace: its chats. */
  render: (workspaceId: string) => ReactNode
}

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
  /** Each workspace's chats under it. Not on the rail. */
  chats?: SidebarWorkspaceChatsSlot
}

// Opens to its height and closes from it, as a step does in the conversation.
const OPEN = { height: 'auto', opacity: 1 }
const SHUT = { height: 0, opacity: 0 }

/**
 * The sidebar's workspaces, with one highlight shared between the selected row and the one
 * pointed at (see `useWorkspaceUnderlay`). Give it a `key` that changes with `rail`: the
 * highlight measures the rows it started with.
 *
 * With `chats`, a row is the workspace's link and the caret beside it, so the highlight covers
 * both, and its chats follow it in the list, outside the row, so it covers none of them.
 */
export const WorkspaceNav = ({ workspaces, selectedWorkspaceId, onSelectWorkspace, notice, rail = false, fades = false, chats }: WorkspaceNavProps) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay()
  const scrollRef = useRef<HTMLElement>(null)
  const reduceMotion = useReducedMotion() ?? false
  useScrollFadeFallback(scrollRef)
  const Item = rail ? WorkspaceRailItem : WorkspaceListItem
  const nested = chats !== undefined && !rail
  // On the rail, a tint of the text colour: black at 8%, white in dark mode.
  const underlay = cn('pointer-events-none absolute inset-x-0 top-0 -z-10 h-0', rail ? 'rounded-xl bg-kumo-contrast/8' : 'rounded-2xl bg-kumo-fill')

  return (
    // Scrolled with no scrollbar, expanded or on the rail.
    <nav ref={scrollRef} aria-label="Workspaces" className={cn('flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto [scrollbar-width:none]', fades && 'chat-fade sidebar-fade')}>
      <div ref={listRef} className="relative isolate flex shrink-0 flex-col">
        <div ref={underlayRef} aria-hidden="true" className={underlay} />
        <div ref={hoverUnderlayRef} aria-hidden="true" className={underlay} />
        {workspaces.map(({ id, ...workspace }) => {
          const selected = id === selectedWorkspaceId
          if (!nested) {
            return <Item key={id} id={id} {...workspace} selected={selected} onSelect={() => onSelectWorkspace(id)} />
          }
          const expanded = chats.isExpanded(id)
          return [
            <div
              key={id}
              data-workspace-id={id}
              aria-current={selected || undefined}
              className={cn(
                'relative rounded-2xl not-data-underlay:hover:bg-kumo-fill',
                selected && 'not-data-underlay:bg-kumo-fill',
              )}
            >
              <WorkspaceListItem {...workspace} selected={selected} onSelect={() => onSelectWorkspace(id)} withToggle />
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${workspace.title}’s chats`}
                onClick={() => chats.onToggle(id)}
                className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-kumo-subtle hover:bg-kumo-contrast/8 hover:text-kumo-default"
              >
                <CaretRightIcon aria-hidden="true" weight="bold" className={cn('size-3 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
              </button>
            </div>,
            <AnimatePresence key={`${id}-chats`} initial={false}>
              {expanded && (
                <motion.div
                  initial={SHUT}
                  animate={OPEN}
                  exit={SHUT}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0, 0.15, 1] }}
                  className="overflow-hidden"
                >
                  {chats.render(id)}
                </motion.div>
              )}
            </AnimatePresence>,
          ]
        })}
      </div>
      {notice && !rail && <p className="px-3 py-2 text-base text-kumo-subtle">{notice}</p>}
    </nav>
  )
}
