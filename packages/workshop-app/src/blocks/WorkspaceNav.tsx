import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { NewWorkspaceRow } from './NewWorkspaceRow'
import { SidebarChatItem, type SidebarChat } from './SidebarChatItem'
import { ChatMenuItems, WorkspaceMenuItems, type MenuWorkspace, type SidebarActions } from './SidebarMenus'
import { WorkspaceListItem, type WorkspaceListItemProps } from './WorkspaceListItem'
import { WorkspaceRailItem } from './WorkspaceRailItem'
import { heldOrder, sameOrder } from './heldOrder'
import { railWorkspacesOf } from './railWorkspaces'
import { useScrollFadeFallback } from './useScrollFadeFallback'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

export type SidebarWorkspace = Omit<WorkspaceListItemProps, 'selected' | 'onSelect'> & {
  id: string
  /** Pinned to the sidebar, as its menu says. */
  pinned?: boolean
  /** The viewer muted it, as its menu says. */
  muted?: boolean
}

export type WorkspaceNavProps = {
  /** The workspaces listed first: in the app, those pinned to the sidebar. */
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** The viewer's recent chats, listed after the workspaces, under Recent where there are both. */
  chats?: SidebarChat[]
  /** The chat that is open. */
  selectedChatId?: string
  onSelectChat?: (chat: SidebarChat) => void
  /** What a row's menu, opened by right-clicking it or pressing and holding it, does. With none, a row has no menu. */
  actions?: SidebarActions
  /** Puts back a chat taken out of the sidebar, which the row it left says it can be for a while. */
  onUnhideChat?: (chat: SidebarChat) => void
  /** Shown in place of the list when there is nothing to list. Not on the rail, which has no room. */
  notice?: string
  /**
   * There are no workspaces: a row where the first would be, which starts a chat, as a chat makes
   * one (`NewWorkspaceRow`), with where that is (`href`).
   */
  empty?: { onNewWorkspace: () => void; href?: string; current?: boolean }
  /** Each workspace is its icon alone, on the collapsed sidebar's rail. */
  rail?: boolean
  /** What scrolls fades out at either end while there is more that way (`.sidebar-fade`). */
  fades?: boolean
}

type MenuTarget = { kind: 'chat'; chat: SidebarChat } | { kind: 'workspace'; workspace: MenuWorkspace }

// How long a chat taken out of the sidebar can be put back from where it was.
const UNDO_FOR = 8000

/**
 * Rows that share one highlight between the selected row and the one pointed at (see
 * `useWorkspaceUnderlay`), the rows being its children that match `rows`.
 */
const RowGroup = ({ rows, rail, children }: { rows: string; rail: boolean; children: ReactNode }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay(rows)
  // On the rail, a tint of the text colour: black at 8%, white in dark mode.
  const underlay = cn('pointer-events-none absolute inset-x-0 top-0 -z-10 h-0', rail ? 'rounded-xl bg-kumo-contrast/8' : 'rounded-2xl bg-kumo-fill')
  return (
    <div ref={listRef} className="relative isolate flex shrink-0 flex-col">
      <div ref={underlayRef} aria-hidden="true" className={underlay} />
      <div ref={hoverUnderlayRef} aria-hidden="true" className={underlay} />
      {children}
    </div>
  )
}

const Heading = ({ children }: { children: ReactNode }) => <h2 className="shrink-0 px-3 pt-3 pb-1 text-sm font-medium text-kumo-subtle first:pt-0">{children}</h2>

/**
 * The sidebar's list: the workspaces given first, as rows, then the viewer's recent chats, each
 * under its workspace's icon. The chats keep their order while the list is pointed at, focused or
 * has a menu open, so that nothing moves from under the pointer; what changed meanwhile takes its
 * place once it is left. A row's menu is opened by right-clicking it, or pressing and holding it on
 * a touch screen. On the rail, each workspace is its icon, the pinned ones first and then those the
 * chats are in, a card of its chats beside it while it is pointed at. Give it a `key` that changes
 * with `rail`: the highlights measure the rows they started with.
 */
export const WorkspaceNav = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  chats = [],
  selectedChatId,
  onSelectChat,
  actions,
  onUnhideChat,
  notice,
  empty,
  rail = false,
  fades = false,
}: WorkspaceNavProps) => {
  const scrollRef = useRef<HTMLElement>(null)
  useScrollFadeFallback(scrollRef)

  const [pointed, setPointed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // What the menu is of, kept while it closes.
  const [menu, setMenu] = useState<MenuTarget>()
  const pressed = useRef<MenuTarget>(undefined)
  // The chat just taken out, and where it was, with the way to put it back for a while.
  const [removed, setRemoved] = useState<{ chat: SidebarChat; at: number }>()
  useEffect(() => {
    if (!removed) return
    const timer = setTimeout(() => setRemoved(undefined), UNDO_FOR)
    return () => clearTimeout(timer)
  }, [removed])

  const keys = chats.map(({ id }) => id)
  const [shown, setShown] = useState(keys)
  const held = pointed || focused || menuOpen
  const order = held ? heldOrder(shown, keys) : keys
  if (!sameOrder(order, shown)) setShown(order)
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const ordered = order.map((key) => byId.get(key)!)

  const chatActions: SidebarActions | undefined = actions && {
    ...actions,
    onHideChat: actions.onHideChat && ((chat) => {
      setRemoved({ chat, at: order.indexOf(chat.id) })
      actions.onHideChat?.(chat)
    }),
  }

  // What a right-click or a press is on: a chat, or a workspace, as it is listed.
  const targetOf = (element: EventTarget | null): MenuTarget | undefined => {
    if (!(element instanceof Element)) return undefined
    const chatId = element.closest('[data-chat-key]')?.getAttribute('data-chat-key')
    const chat = chatId ? byId.get(chatId) : undefined
    if (chat) return { kind: 'chat', chat }
    const workspaceId = element.closest('[data-workspace-id]')?.getAttribute('data-workspace-id')
    if (!workspaceId) return undefined
    const listed = workspaces.find(({ id }) => id === workspaceId)
    const fromChats = ordered.find((each) => each.workspaceId === workspaceId)
    return {
      kind: 'workspace',
      workspace: listed
        ? { id: workspaceId, pinned: listed.pinned, muted: listed.muted, unread: listed.unread, href: listed.href }
        : { id: workspaceId, pinned: fromChats?.workspacePinned, muted: fromChats?.workspaceMuted, unread: ordered.some((each) => each.workspaceId === workspaceId && each.unread), href: fromChats?.workspaceHref },
    }
  }
  const press = (event: SyntheticEvent) => {
    pressed.current = targetOf(event.target)
  }

  const workspaceItem = ({ id, pinned: _pinned, muted: _muted, ...workspace }: SidebarWorkspace) => (
    <WorkspaceListItem key={id} id={id} {...workspace} selected={id === selectedWorkspaceId} onSelect={() => onSelectWorkspace(id)} />
  )
  const chatItem = (chat: SidebarChat) => (
    <SidebarChatItem key={chat.id} {...chat} selected={chat.id === selectedChatId} onSelect={() => onSelectChat?.(chat)} />
  )
  const undoRow = removed && (
    <div key="removed" role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-kumo-subtle">
      <span className="min-w-0 flex-1 truncate">Removed “{removed.chat.title}”</span>
      <button
        type="button"
        className="cursor-pointer rounded-full px-2 py-0.5 font-medium text-kumo-default hover:bg-kumo-fill"
        onClick={() => {
          onUnhideChat?.(removed.chat)
          setRemoved(undefined)
        }}
      >
        Undo
      </button>
    </div>
  )
  const chatRows = ordered.map(chatItem)
  if (undoRow && !byId.has(removed.chat.id)) chatRows.splice(Math.min(removed.at, chatRows.length), 0, undoRow)

  const list = rail
    ? (
        <RowGroup rows="[data-workspace-id]" rail>
          {railWorkspacesOf(workspaces, ordered).map(({ id, pinned: _pinned, muted: _muted, chats: its, ...workspace }) => (
            <WorkspaceRailItem
              key={id}
              id={id}
              {...workspace}
              selected={id === selectedWorkspaceId}
              onSelect={() => onSelectWorkspace(id)}
              chats={its}
              selectedChatId={selectedChatId}
              onSelectChat={onSelectChat}
              onNewChat={actions?.onNewChat && (() => actions.onNewChat?.(id))}
            />
          ))}
          {empty && workspaces.length === 0 && chats.length === 0 && <NewWorkspaceRow rail href={empty.href} current={empty.current} onSelect={empty.onNewWorkspace} />}
        </RowGroup>
      )
    : (
        <>
          {workspaces.length > 0 && chatRows.length > 0 && <Heading>Pinned</Heading>}
          {(workspaces.length > 0 || (empty && chats.length === 0)) && (
            <RowGroup rows="[data-workspace-id]" rail={false}>
              {workspaces.map(workspaceItem)}
              {empty && workspaces.length === 0 && chats.length === 0 && <NewWorkspaceRow href={empty.href} current={empty.current} onSelect={empty.onNewWorkspace} />}
            </RowGroup>
          )}
          {workspaces.length > 0 && chatRows.length > 0 && <Heading>Recent</Heading>}
          {chatRows.length > 0 && <RowGroup rows="[data-chat-key]" rail={false}>{chatRows}</RowGroup>}
        </>
      )

  const nav = (
    // Scrolled with no scrollbar, expanded or on the rail, with room around it for the rows' focus rings, which scrolling would clip.
    <nav
      ref={scrollRef}
      aria-label="Workspaces and chats"
      onPointerEnter={(event) => event.pointerType !== 'touch' && setPointed(true)}
      onPointerLeave={(event) => {
        setPointed(false)
        // Focus left behind by a row that has gone, or by a menu given back, holds nothing.
        const active = document.activeElement
        if (!active || !event.currentTarget.contains(active) || !active.matches(':focus-visible')) setFocused(false)
      }}
      // Only focus moved with the keyboard holds the order: a click or a menu closing focuses too.
      onFocus={(event) => setFocused(event.target.matches(':focus-visible'))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onContextMenuCapture={press}
      onTouchStartCapture={press}
      className={cn(
        '-mx-1 -my-1 flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto p-1 [scrollbar-width:none]',
        // Held down on a touch screen for its menu, not the browser's own for a link, nor a selection.
        actions && 'select-none [-webkit-touch-callout:none]',
        fades && 'chat-fade sidebar-fade',
      )}
    >
      {list}
      {notice && !rail && <p className="px-3 py-2 text-base text-kumo-subtle">{notice}</p>}
    </nav>
  )

  if (!actions) return nav
  return (
    <ContextMenu
      trigger={nav}
      aria-label={menu?.kind === 'chat' ? `${menu.chat.title}, options` : 'Workspace options'}
      open={menuOpen}
      onOpenChange={(open) => {
        // Only over a row: elsewhere in the list there is nothing for it to be of.
        if (open && !pressed.current) return
        if (open) setMenu(pressed.current)
        setMenuOpen(open)
      }}
    >
      {menu?.kind === 'chat' && chatActions && <ChatMenuItems chat={menu.chat} actions={chatActions} />}
      {menu?.kind === 'workspace' && <WorkspaceMenuItems workspace={menu.workspace} actions={actions} />}
    </ContextMenu>
  )
}
