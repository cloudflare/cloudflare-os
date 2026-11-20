import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, type MotionValue } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { NewWorkspaceRow } from './NewWorkspaceRow'
import { PinnedWorkspaces } from './PinnedWorkspaces'
import { SidebarChatItem, type SidebarChat } from './SidebarChatItem'
import { ChatMenuItems, WorkspaceMenuItems, type MenuWorkspace, type SidebarActions } from './SidebarMenus'
import { WorkspaceListItem, type WorkspaceListItemProps } from './WorkspaceListItem'
import { WorkspaceRailItem } from './WorkspaceRailItem'
import { useScrollFadeFallback } from '@gadgets/ui'
import { heldOrder, sameOrder } from './heldOrder'
import { useRowSlide } from './useRowSlide'
import { railWorkspacesOf, type RailWorkspace } from './railWorkspaces'
import { usePinDrag, type PinDrag, type PinDragSource } from './usePinDrag'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

export type SidebarWorkspace = Omit<WorkspaceListItemProps, 'selected' | 'onSelect'> & {
  id: string
  /** Pinned to the sidebar, as its menu says. */
  pinned?: boolean
  /** The viewer muted it, as its menu says. */
  muted?: boolean
}

export type WorkspaceNavProps = {
  /** The workspaces pinned to the sidebar, as tiles over everything else in it (`PinnedWorkspaces`). */
  pinned?: SidebarWorkspace[]
  /** Puts the pinned workspaces in another order, giving their ids in the new one. */
  onReorderPinned?: (ids: string[]) => void
  /** Workspaces listed as rows before the chats: in the app, the latest, while there is nothing else to list. */
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** The viewer's recent chats, listed after the workspaces. */
  chats?: SidebarChat[]
  /** The chat that is open. */
  selectedChatId?: string
  onSelectChat?: (chat: SidebarChat) => void
  /** What a row's menu, opened by right-clicking it or pressing and holding it, does. With none, a row has no menu. */
  actions?: SidebarActions
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

/**
 * Rows that share one highlight between the selected row and the one pointed at (see
 * `useWorkspaceUnderlay`), the rows being its children that match `rows`. They slide to a new
 * place, the highlight with them, and new ones fade in (`useRowSlide`).
 */
const RowGroup = ({ rows, rail, children }: { rows: string; rail: boolean; children: ReactNode }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay(rows)
  useRowSlide(listRef, rows, [underlayRef, hoverUnderlayRef])
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

type GhostMotion = { x: MotionValue<number>; y: MotionValue<number>; scale: MotionValue<number>; opacity: MotionValue<number> }

/** A workspace's icon as it is dragged: jiggling while held, at the middle of where `ghost` puts it. */
const PinGhost = ({ drag, ghost }: { drag: PinDrag; ghost: GhostMotion }) =>
  createPortal(
    <motion.div aria-hidden="true" className="pointer-events-none fixed top-0 left-0 z-50" style={{ x: ghost.x, y: ghost.y, opacity: ghost.opacity }}>
      <motion.div className="-translate-x-1/2 -translate-y-1/2" style={{ scale: ghost.scale }}>
        <span className={cn('flex transition-[filter] duration-300', drag.result ? 'drop-shadow-none' : 'jiggle drop-shadow-lg')}>
          <WorkspaceIcon label={drag.workspaceLabel} {...drag.workspaceLook} />
        </span>
      </motion.div>
    </motion.div>,
    document.body,
  )

/**
 * The sidebar's list: the pinned workspaces, as tiles, then the workspaces given as rows, then the
 * viewer's recent chats, each under its workspace's icon. A row is dragged with a mouse onto the
 * tiles to pin its workspace, which its icon, jiggling, follows the pointer for. The chats keep their order while the list is pointed at, focused or
 * has a menu open, so that nothing moves from under the pointer; what changed meanwhile takes its
 * place once it is left. A row's menu is opened by right-clicking it, or pressing and holding it on
 * a touch screen. On the rail, each workspace is its icon, the pinned ones first and then those the
 * chats are in, a card of its chats beside it while it is pointed at. Give it a `key` that changes
 * with `rail`: the highlights measure the rows they started with.
 */
export const WorkspaceNav = ({
  pinned = [],
  onReorderPinned,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  chats = [],
  selectedChatId,
  onSelectChat,
  actions,
  notice,
  empty,
  rail = false,
  fades = false,
}: WorkspaceNavProps) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollFadeFallback(scrollRef)

  const [pointed, setPointed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // What the menu is of, kept while it closes.
  const [menu, setMenu] = useState<MenuTarget>()
  const pressed = useRef<MenuTarget>(undefined)
  // What is not among the recent chats is first whatever is held (`SidebarChat.ghost`), and one
  // that comes to be among them while it is held stays where it was.
  const ghostKeys = chats.filter(({ ghost }) => ghost).map(({ id }) => id)
  const keys = chats.filter(({ ghost }) => !ghost).map(({ id }) => id)
  const [shown, setShown] = useState([...ghostKeys, ...keys])
  const held = pointed || focused || menuOpen
  const order = [...ghostKeys, ...(held ? heldOrder(shown.filter((key) => !ghostKeys.includes(key)), keys) : keys)]
  if (!sameOrder(order, shown)) setShown(order)
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const ordered = order.map((key) => byId.get(key)!)

  // What a right-click or a press is on: a chat, or a workspace, as it is listed.
  const targetOf = (element: EventTarget | null): MenuTarget | undefined => {
    if (!(element instanceof Element)) return undefined
    const chatId = element.closest('[data-chat-key]')?.getAttribute('data-chat-key')
    const chat = chatId ? byId.get(chatId) : undefined
    if (chat) return { kind: 'chat', chat }
    const workspaceId = element.closest('[data-workspace-id]')?.getAttribute('data-workspace-id')
    if (!workspaceId) return undefined
    const listed = [...pinned, ...workspaces].find(({ id }) => id === workspaceId)
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

  // What dragging a row pins: its workspace, or nothing, back where it was, if that is pinned already. A tile is moved, or unpinned.
  const pinnedIds = new Set(pinned.map(({ id }) => id))
  const pinSourceOf = (element: Element): PinDragSource | undefined => {
    if (rail || !actions?.onPinWorkspace) return undefined
    const tileId = element.closest('[data-pin-drop] [data-workspace-id]')?.getAttribute('data-workspace-id')
    const tile = tileId ? pinned.find(({ id }) => id === tileId) : undefined
    if (tile) return { workspaceId: tile.id, workspaceLabel: tile.workspaceLabel, workspaceLook: tile.workspaceLook, pinned: true }
    const chatId = element.closest('[data-chat-key]')?.getAttribute('data-chat-key')
    const chat = chatId ? byId.get(chatId) : undefined
    const workspaceId = chat?.workspaceId ?? element.closest('[data-workspace-id]')?.getAttribute('data-workspace-id')
    if (!workspaceId) return undefined
    const alreadyPinned = pinnedIds.has(workspaceId)
    const workspace = workspaces.find(({ id }) => id === workspaceId)
    if (chat) return { workspaceId, workspaceLabel: chat.workspaceLabel, workspaceLook: chat.workspaceLook, pinned: false, alreadyPinned }
    return workspace && { workspaceId, workspaceLabel: workspace.workspaceLabel, workspaceLook: workspace.workspaceLook, pinned: false, alreadyPinned }
  }
  const pinDrag = usePinDrag(pinSourceOf, {
    onPin: (workspaceId, at) => actions?.onPinWorkspace?.(workspaceId, true, at),
    onMove: (workspaceId, at) => {
      const ids = pinned.map(({ id }) => id).filter((id) => id !== workspaceId)
      ids.splice(at, 0, workspaceId)
      onReorderPinned?.(ids)
    },
    onUnpin: (workspaceId) => actions?.onPinWorkspace?.(workspaceId, false),
  })
  const { drag } = pinDrag

  // The row the menu is open on, as its chat's key or its workspace's id.
  const menuOn = menuOpen ? (menu?.kind === 'chat' ? menu.chat.id : menu?.workspace.id) : undefined

  const workspaceItem = ({ id, pinned: _pinned, muted: _muted, ...workspace }: SidebarWorkspace) => (
    <WorkspaceListItem key={id} id={id} {...workspace} selected={id === selectedWorkspaceId} menuOpen={id === menuOn} onSelect={() => onSelectWorkspace(id)} />
  )
  const chatItem = (chat: SidebarChat) => (
    <SidebarChatItem key={chat.id} {...chat} selected={chat.id === selectedChatId} menuOpen={chat.id === menuOn} onSelect={() => onSelectChat?.(chat)} />
  )
  const chatRows = ordered.map(chatItem)

  const railItem = ({ id, pinned: _pinned, muted: _muted, chats: its, ...workspace }: RailWorkspace) => (
    <WorkspaceRailItem
      key={id}
      id={id}
      {...workspace}
      selected={id === selectedWorkspaceId}
      menuOpen={id === menuOn}
      onSelect={() => onSelectWorkspace(id)}
      chats={its}
      selectedChatId={selectedChatId}
      onSelectChat={onSelectChat}
    />
  )
  // The pinned first, apart from the rest, as the expanded sidebar has them over its list.
  const onRail = railWorkspacesOf([...pinned, ...workspaces], ordered)
  const pinnedOnRail = onRail.slice(0, pinned.length)
  const restOnRail = onRail.slice(pinned.length)
  const nothing = empty && pinned.length === 0 && workspaces.length === 0 && chats.length === 0
  const list = rail
    ? (
        <>
          {pinnedOnRail.length > 0 && <RowGroup rows="[data-workspace-id]" rail>{pinnedOnRail.map(railItem)}</RowGroup>}
          {pinnedOnRail.length > 0 && restOnRail.length > 0 && <div aria-hidden="true" className="mx-auto my-2 h-px w-4 shrink-0 bg-kumo-line" />}
          {(restOnRail.length > 0 || nothing) && (
            <RowGroup rows="[data-workspace-id]" rail>
              {restOnRail.map(railItem)}
              {nothing && <NewWorkspaceRow rail href={empty.href} current={empty.current} onSelect={empty.onNewWorkspace} />}
            </RowGroup>
          )}
        </>
      )
    : (
        <>
          {(workspaces.length > 0 || (empty && pinned.length === 0 && chats.length === 0)) && (
            <RowGroup rows="[data-workspace-id]" rail={false}>
              {workspaces.map(workspaceItem)}
              {empty && pinned.length === 0 && workspaces.length === 0 && chats.length === 0 && <NewWorkspaceRow href={empty.href} current={empty.current} onSelect={empty.onNewWorkspace} />}
            </RowGroup>
          )}
          {chatRows.length > 0 && <RowGroup rows="[data-chat-key]" rail={false}>{chatRows}</RowGroup>}
          {drag && <PinGhost drag={drag} ghost={pinDrag.ghost} />}
        </>
      )

  const nav = (
    <nav
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
      onPointerDown={pinDrag.onPointerDown}
      onDragStart={pinDrag.onDragStart}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        // Held down on a touch screen for its menu, not the browser's own for a link, nor a selection.
        actions && 'select-none [-webkit-touch-callout:none]',
      )}
    >
      {/* Stays put over the list, which scrolls under it. */}
      {!rail && (
        <PinnedWorkspaces
          workspaces={pinned}
          selectedId={selectedWorkspaceId}
          menuOpenId={menuOn}
          onSelect={onSelectWorkspace}
          onReorder={onReorderPinned}
          // The area does not open for a workspace it has already.
          drag={drag?.alreadyPinned ? undefined : drag}
          dropRef={pinDrag.dropRef}
        />
      )}
      {/* Scrolled with no scrollbar, expanded or on the rail, with room around it for the rows' focus rings, which scrolling would clip. */}
      <div ref={scrollRef} className={cn('-mx-1 -my-1 flex min-h-0 flex-1 flex-col gap-0 overflow-x-hidden overflow-y-auto overscroll-x-none p-1 [scrollbar-width:none]', fades && 'chat-fade sidebar-fade')}>
        {list}
        {notice && !rail && <p className="px-3 py-2 text-base text-kumo-subtle">{notice}</p>}
      </div>
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
      {menu?.kind === 'chat' && actions && <ChatMenuItems chat={menu.chat} actions={actions} />}
      {menu?.kind === 'workspace' && <WorkspaceMenuItems workspace={menu.workspace} actions={actions} />}
    </ContextMenu>
  )
}
