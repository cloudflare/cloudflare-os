import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { ContextMenu, DropdownMenuEntries, type MenuEntry } from '../../components/ContextMenu'
import { useNavigate } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AiChatMetadata,
  ChatFileSummary,
  CollaboratorInfo,
  GadgetSummary,
  NotificationMute,
  Overseer,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useDocumentTitle } from '../../useDocumentTitle'
import { logRpcFailure } from '../../rpcErrors'
import { isImeComposing } from '../../keyboardEvent'
import { SplitPage } from '../../components/AppShell/SplitPage'
import { PageHeader, PageTabs } from '../../components/PageHeader'
import { RoundButton } from '../../components/RoundButton'
import { PersonAvatar } from '../../components/PersonAvatar'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { AgentMark, ChatCloudMark, FolderBadge } from '../../components/icons/brandMarks'
import {
  AppsIcon,
  FolderSolidOutlineIcon,
  HistoryIcon,
  MoreIcon,
  StarIcon,
  UserPlusIcon,
} from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { WorkspaceNotificationsMenu } from '../../features/notifications/WorkspaceNotificationsMenu'
import { useRecentChats } from '../../features/recent-chats/useRecentChats'
import { MemberStack } from '../../features/workspaces/MemberStack'
import { workspaceInitials } from '../../features/workspaces/workspaceInitials'
import { LibraryCollection, StarFilledIcon, type LibraryItem } from '../../features/library/LibraryViews'
import {
  LibrarySearch,
  LibraryViewControls,
  NewMenuButton,
  arrangeLibraryItems,
  type LibraryFilterOption,
  type LibrarySort,
} from '../../features/library/LibraryToolbar'
import { LibraryPreviewPane } from '../../features/library/LibraryPreviewPane'
import { favoriteRefKey, useFavorites } from '../../features/library/useLibraryData'
import { useLibraryItems } from '../../features/library/useLibraryItems'
import { useLibraryLayout } from '../../features/library/useLibraryLayout'
import { AutomationList } from '../../features/automations/AutomationList'
import { AgentList } from '../../features/automations/AgentList'
import { agoLabel } from '../../features/library/libraryTime'

/** A workspace page's tabs (Figma "Frame 800"). */
export type WorkspaceTab = 'chats' | 'library' | 'automations' | 'members' | 'activity'

const TABS: { value: WorkspaceTab; label: string }[] = [
  { value: 'chats', label: 'Chats' },
  { value: 'library', label: 'Library' },
  { value: 'automations', label: 'Automations' },
  { value: 'members', label: 'Members' },
  { value: 'activity', label: 'Activity' },
]

const CHAT_FILTERS: LibraryFilterOption[] = [
  { value: 'all', label: 'All chats' },
  { value: 'agents', label: "Agents' conversations" },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
]

const LIBRARY_FILTERS: LibraryFilterOption[] = [
  { value: 'all', label: 'Everything' },
  { value: 'app', label: 'Apps' },
  { value: 'file', label: 'Files' },
]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// The row's quiet details (Figma "Frame 828"-"831"): an icon and a label at half strength.
const Detail = ({ icon, children, className = '' }: { icon: ReactNode; children: ReactNode; className?: string }) => (
  <span className={`flex shrink-0 items-center gap-1.5 text-[13px] font-medium leading-4 text-kumo-default opacity-50 ${className}`}>
    {icon}
    {children}
  </span>
)

const ROW_ICON_BUTTON = 'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-default transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'

type ChatRowData = {
  chat: AiChatMetadata
  unread: number
  archived: boolean
  starred: boolean
  files: number
  apps: number
}

/** A workspace's chat (Figma "Frame 681"): who started it, its name, when, what it holds. */
function ChatRow({ row, renaming, onOpen, onToggleStar, onRename, onRenameDone, menu }: {
  row: ChatRowData
  renaming: boolean
  onOpen: () => void
  onToggleStar: () => void
  onRename: (title: string) => void
  onRenameDone: () => void
  menu: ReactNode
}) {
  const { chat } = row
  const [draft, setDraft] = useState(chat.title)
  useEffect(() => { if (renaming) setDraft(chat.title) }, [renaming, chat.title])
  const finishRename = () => {
    const title = draft.trim()
    if (title && title !== chat.title) onRename(title)
    onRenameDone()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={renaming ? undefined : onOpen}
      onKeyDown={event => {
        if (renaming || event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }}
      className={`group/row flex h-12 cursor-pointer items-center gap-3 rounded-[14px] px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-ring ${
        renaming ? 'bg-kumo-tint' : 'hover:bg-kumo-tint has-[[data-popup-open]]:bg-kumo-tint [[data-popup-open]>&]:bg-kumo-tint'
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex size-[18px] shrink-0 items-center justify-center text-kumo-contrast" aria-hidden="true">
          {chat.spawnerName ? <AgentMark size={18} /> : <ChatCloudMark size={18} />}
        </span>
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onClick={event => event.stopPropagation()}
            onBlur={finishRename}
            onKeyDown={event => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') { event.preventDefault(); finishRename() }
              if (event.key === 'Escape') { event.preventDefault(); onRenameDone() }
            }}
            aria-label={`Rename ${chat.title}`}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[14px] font-medium leading-[17px] text-kumo-default outline-none"
          />
        ) : (
          <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default" title={chat.title}>
            {chat.title}
          </span>
        )}
        {row.unread > 0 && (
          <span className="size-2 shrink-0 rounded-full bg-kumo-brand" aria-label={`${plural(row.unread, 'unread message', 'unread messages')}`} />
        )}
        {chat.activeAgent ? (
          <Detail icon={<span className="size-1.5 animate-pulse rounded-full bg-kumo-brand" />} className="!opacity-100 px-2 !text-kumo-brand">
            Working
          </Detail>
        ) : (
          <Detail icon={<HistoryIcon size={16} />} className="px-2 max-sm:hidden">
            {agoLabel(chat.lastActive)}
          </Detail>
        )}
        {row.archived && <Detail icon={null} className="max-sm:hidden">Archived</Detail>}
        {chat.spawnerName && <Detail icon={null} className="max-lg:hidden">{chat.spawnerName}</Detail>}
      </span>
      <span className="flex shrink-0 items-center gap-4">
        {row.files > 0 && (
          <Detail icon={<FolderSolidOutlineIcon size={16} />} className="max-sm:hidden">{plural(row.files, 'file', 'files')}</Detail>
        )}
        {row.apps > 0 && (
          <Detail icon={<AppsIcon size={16} />} className="max-sm:hidden">{plural(row.apps, 'app', 'apps')}</Detail>
        )}
        <button
          type="button"
          onClick={event => { event.stopPropagation(); onToggleStar() }}
          aria-label={row.starred ? `Unstar ${chat.title}` : `Star ${chat.title}`}
          aria-pressed={row.starred}
          className={`${ROW_ICON_BUTTON} ${row.starred ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover/row:opacity-50 hover:!opacity-100'}`}
        >
          {row.starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
        </button>
        <DropdownMenu>
          <DropdownMenu.Trigger render={
            <button
              type="button"
              onClick={event => event.stopPropagation()}
              aria-label={`More for ${chat.title}`}
              className={`${ROW_ICON_BUTTON} opacity-0 hover:!opacity-100 group-hover/row:opacity-50 data-[popup-open]:opacity-100`}
            >
              <MoreIcon size={16} />
            </button>
          } />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
            {menu}
          </DropdownMenu.Content>
        </DropdownMenu>
      </span>
    </div>
  )
}

const ROLE_LABELS = { owner: 'Owner', build: 'Member', use: 'Uses apps' } as const

/** A workspace member (in the Library row's shape): face, name, and what they can do. */
function MemberRow({ person, role, you }: { person: AiChatAuthorInfo; role: keyof typeof ROLE_LABELS; you: boolean }) {
  const { authenticatedApi } = useAuthenticatedApi()
  return (
    <div className="flex h-12 items-center gap-3 rounded-[14px] px-3">
      <PersonAvatar api={authenticatedApi} userId={person.id} name={person.name} size={25} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">{person.name}</span>
        {you && <span className="shrink-0 text-[13px] text-kumo-subtle">You</span>}
      </span>
      <span className="shrink-0 text-[13px] font-medium leading-4 text-kumo-subtle">{ROLE_LABELS[role]}</span>
    </div>
  )
}

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
  </div>
)

const Empty = ({ children }: { children: ReactNode }) =>
  <div className="py-16 text-center text-[13px] leading-5 text-kumo-subtle">{children}</div>

/**
 * A workspace (Figma "MacBook Pro 14\" - 20", "- 21", "- 23" and "iPhone 16 Pro - 1"): its name,
 * members and invite button above tabs of its chats, its apps and files, its members and its
 * activity. Shown at a workspace's address when no chat is open.
 */
export function WorkspacePage({
  metadata,
  overseer,
  chats,
  gadgets,
  tab,
  onTabChange,
  onOpenChat,
  onInvite,
  activity,
}: {
  metadata: WorkspaceMetadata
  overseer: RpcStub<Overseer>
  /** The workspace's chats, most recently active first; null until loaded. */
  chats: readonly AiChatMetadata[] | null
  gadgets: readonly GadgetSummary[]
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  onOpenChat: (chatId: number) => void
  onInvite: () => void
  /** The Activity tab's content, which the workspace's editor already holds. */
  activity: ReactNode
}) {
  const workspaceId = metadata.id
  useDocumentTitle(metadata.title)
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const threads = useRecentChats(authenticatedApi)
  const { favorites, starred, setStarred } = useFavorites()
  const [layout, setLayout] = useLibraryLayout()
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Record<WorkspaceTab, string>>({
    chats: 'all', library: 'all', automations: 'all', members: 'all', activity: 'all',
  })
  const [renamingChat, setRenamingChat] = useState<number | null>(null)
  const [deletingChat, setDeletingChat] = useState<AiChatMetadata | null>(null)
  const [renamingWorkspace, setRenamingWorkspace] = useState(false)
  const [workspaceTitle, setWorkspaceTitle] = useState(metadata.title)
  const [deletingWorkspace, setDeletingWorkspace] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [mute, setMute] = useState<NotificationMute | undefined>(metadata.notificationMute)
  const [paneExpanded, setPaneExpanded] = useState(false)
  // Archiving answers at once; the user's thread list catches up when it next refetches.
  const [archived, setArchived] = useState<ReadonlyMap<number, boolean>>(new Map())
  useEffect(() => setMute(metadata.notificationMute), [metadata.notificationMute])
  useEffect(() => { if (!renamingWorkspace) setWorkspaceTitle(metadata.title) }, [metadata.title, renamingWorkspace])

  // Files, read again whenever a chat moves on, since that is when one can have been added.
  const [files, setFiles] = useState<ChatFileSummary[] | null>(null)
  const latestActivity = chats?.[0]?.lastActive.getTime()
  useEffect(() => {
    let cancelled = false
    overseer.listChatFiles().then(
      list => { if (!cancelled) setFiles(list) },
      err => { logRpcFailure('Failed to list the workspace\'s files:', err); if (!cancelled) setFiles(current => current ?? []) })
    return () => { cancelled = true }
  }, [overseer, latestActivity])

  // Everyone in the workspace: the owner first, then whoever it is shared with.
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    overseer.listCollaborators().then(
      list => { if (!cancelled) setCollaborators(list) },
      err => { logRpcFailure('Failed to list workspace members:', err); if (!cancelled) setCollaborators([]) })
    return () => { cancelled = true }
  }, [overseer])
  const owner = metadata.owner ?? currentUser
  const members = useMemo(() => {
    if (!owner) return []
    const others = (collaborators ?? []).filter(c => c.profile.id !== owner.id)
    return [
      { person: owner, role: 'owner' as const },
      ...others.map(c => ({ person: c.profile, role: c.access.role })),
    ]
  }, [owner, collaborators])

  // ── Chats ──────────────────────────────────────────────────────────────────────
  const chatRows: ChatRowData[] = useMemo(() => {
    const threadOf = new Map((threads ?? []).filter(t => t.workspaceId === workspaceId).map(t => [t.chatId, t]))
    const filesOf = new Map<number, number>()
    for (const file of files ?? []) filesOf.set(file.chatId, (filesOf.get(file.chatId) ?? 0) + 1)
    return (chats ?? []).map(chat => {
      // A chat's apps: the drafts it made, and the apps it is changing.
      const apps = new Set([
        ...gadgets.filter(g => g.chatId === chat.id).map(g => g.id),
        ...(chat.proposedChangeWorkpieces ?? []).filter(id => gadgets.some(g => g.id === id)),
      ])
      return {
        chat,
        unread: threadOf.get(chat.id)?.unreadMessageCount ?? 0,
        archived: archived.get(chat.id) ?? threadOf.get(chat.id)?.archived === true,
        starred: starred.has(favoriteRefKey({ kind: 'chat', workspaceId, chatId: chat.id })),
        files: filesOf.get(chat.id) ?? 0,
        apps: apps.size,
      }
    })
  }, [chats, threads, files, gadgets, starred, archived, workspaceId])

  const chatFilter = filters.chats
  const needle = query.trim().toLowerCase()
  const shownChats = chatRows
    .filter(row => !needle || row.chat.title.toLowerCase().includes(needle))
    .filter(row => chatFilter === 'archived' ? row.archived
      : chatFilter === 'agents' ? !!row.chat.spawnerName
      // An agent's conversations belong to it (see Automations), not among people's chats.
      : row.chat.spawnerName ? false
      : chatFilter === 'unread' ? row.unread > 0
      : true)
    .toSorted(sort === 'name' ? (a, b) => a.chat.title.localeCompare(b.chat.title) : () => 0)
  const chatGroups = [shownChats.filter(row => row.starred), shownChats.filter(row => !row.starred)]
    .filter(group => group.length > 0)

  const starChat = (chat: AiChatMetadata, star: boolean) =>
    void setStarred({ kind: 'chat', workspaceId, chatId: chat.id, title: chat.title }, star)
  const renameChat = (chat: AiChatMetadata, title: string) => {
    overseer.setChatTitle(chat.id, title).catch(err => {
      logRpcFailure('Failed to rename chat:', err)
      toasts.add({ title: "Couldn't rename the chat", variant: 'error' })
    })
  }
  const archiveChat = (chat: AiChatMetadata, archive: boolean) => {
    setArchived(current => new Map(current).set(chat.id, archive))
    authenticatedApi.setChatArchived(workspaceId, chat.id, archive).catch(err => {
      logRpcFailure('Failed to archive chat:', err)
      setArchived(current => { const next = new Map(current); next.delete(chat.id); return next })
      toasts.add({ title: archive ? "Couldn't archive the chat" : "Couldn't unarchive the chat", variant: 'error' })
    })
  }
  const markChat = (row: ChatRowData) => {
    const call = row.unread > 0 ? overseer.markChatRead(row.chat.id) : overseer.markChatUnread(row.chat.id)
    Promise.resolve(call).catch(err => {
      logRpcFailure('Failed to change read state:', err)
      toasts.add({ title: "Couldn't update the chat", variant: 'error' })
    })
  }
  const deleteChat = async () => {
    if (!deletingChat) return
    setDeleting(true)
    try {
      await overseer.deleteChat(deletingChat.id)
      if (starred.has(favoriteRefKey({ kind: 'chat', workspaceId, chatId: deletingChat.id }))) starChat(deletingChat, false)
      setDeletingChat(null)
    } catch (err) {
      logRpcFailure('Failed to delete chat:', err)
      toasts.add({ title: "Couldn't delete the chat", variant: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  // ── Library ────────────────────────────────────────────────────────────────────
  const lastActive = chats?.[0]?.lastActive ?? new Date(0)
  const apps = useMemo(() => gadgets
    .filter(g => g.chatId === undefined)
    .map(g => ({ workspaceId, workpieceId: g.id, title: g.title, output: g.output, date: lastActive })),
  [gadgets, workspaceId, lastActive])
  const workspaceFiles = useMemo(() => (files ?? []).map(file => ({ ...file, workspaceId })), [files, workspaceId])
  const { appItems, fileItems, preview, setPreview } = useLibraryItems({
    apps, files: workspaceFiles, favorites: favorites ?? [], starred, showContext: false,
  })
  const libraryFilter = filters.library
  const libraryItems: LibraryItem[] = useMemo(() => arrangeLibraryItems(
    [...appItems, ...fileItems].filter(item => libraryFilter === 'all' || item.kind === libraryFilter), sort, query,
  ), [appItems, fileItems, libraryFilter, sort, query])

  // ── Workspace ──────────────────────────────────────────────────────────────────
  const isOwner = !metadata.owner
  const renameWorkspace = async () => {
    setRenamingWorkspace(false)
    const title = workspaceTitle.trim()
    if (!title || title === metadata.title) { setWorkspaceTitle(metadata.title); return }
    try {
      await overseer.setTitle(title)
    } catch (err) {
      logRpcFailure('Failed to rename workspace:', err)
      setWorkspaceTitle(metadata.title)
      toasts.add({ title: "Couldn't rename the workspace", variant: 'error' })
    }
  }
  const deleteWorkspace = async () => {
    setDeleting(true)
    try {
      await overseer.deleteSelf()
      navigate({ to: '/workspaces' })
    } catch (err) {
      logRpcFailure('Failed to delete workspace:', err)
      toasts.add({ title: "Couldn't delete the workspace", variant: 'error' })
      setDeleting(false)
      setDeletingWorkspace(false)
    }
  }
  const startChat = () => navigate({ to: '/', search: { workspace: workspaceId } })

  const titleInputRef = useRef<HTMLInputElement>(null)
  const badge = <FolderBadge initials={workspaceInitials(workspaceTitle)} size={24} className="shrink-0 text-kumo-contrast" />
  const people = members.map(member => member.person)

  const filterOptions = tab === 'chats' ? CHAT_FILTERS : tab === 'library' ? LIBRARY_FILTERS : undefined
  const showToolbar = tab === 'chats' || tab === 'library'

  return (
    <SplitPage
      paneExpanded={paneExpanded}
      pane={preview && (
        <LibraryPreviewPane
          preview={preview}
          onClose={() => { setPreview(null); setPaneExpanded(false) }}
          expanded={paneExpanded}
          onExpandedChange={setPaneExpanded}
        />
      )}
    >
      <PageHeader
        icon={badge}
        title={renamingWorkspace ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={workspaceTitle}
            onChange={event => setWorkspaceTitle(event.target.value)}
            onBlur={() => void renameWorkspace()}
            onKeyDown={event => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') { event.preventDefault(); void renameWorkspace() }
              if (event.key === 'Escape') { event.preventDefault(); setWorkspaceTitle(metadata.title); setRenamingWorkspace(false) }
            }}
            aria-label="Workspace name"
            spellCheck={false}
            size={Math.max(8, workspaceTitle.length)}
            className="min-w-0 bg-transparent font-medium text-kumo-default outline-none"
          />
        ) : workspaceTitle}
        menu={renamingWorkspace ? undefined : <>
          <DropdownMenu.Item onClick={() => setRenamingWorkspace(true)} className={MENU_ITEM}>Rename</DropdownMenu.Item>
          <DropdownMenu.Item onClick={onInvite} className={MENU_ITEM}>Invite people…</DropdownMenu.Item>
          <WorkspaceNotificationsMenu workspaceId={workspaceId} mute={mute} onMuteChange={setMute} />
          {metadata.totalCost !== undefined && metadata.totalCost > 0 && (
            <div className="px-2.5 py-1.5 text-[12px] leading-4 text-kumo-subtle">
              ${metadata.totalCost.toFixed(2)} spent on AI
            </div>
          )}
          {isOwner && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => setDeletingWorkspace(true)} className={MENU_ITEM_DANGER}>
                Delete workspace
              </DropdownMenu.Item>
            </>
          )}
        </>}
      >
        {people.length > 0 && (
          <button type="button" onClick={() => onTabChange('members')} aria-label="Members"
            className="flex cursor-pointer items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
            {/* 24px faces at the desk, 32px on a phone (Figma "iPhone 16 Pro - 1"). */}
            <span className="max-md:hidden"><MemberStack people={people} size={24} /></span>
            <span className="md:hidden"><MemberStack people={people} size={32} /></span>
          </button>
        )}
        <RoundButton label="Invite people" onClick={onInvite} className="max-md:!size-11">
          <UserPlusIcon size={16} />
        </RoundButton>
      </PageHeader>

      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-3 px-3 pb-3 max-md:px-4">
        <PageTabs label="Workspace" tabs={TABS} value={tab} onChange={next => { setQuery(''); onTabChange(next) }} />
        <span className="flex-1" />
        {showToolbar && (
          <div className="flex items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:bottom-4 max-md:z-10 max-md:justify-center">
            <LibraryViewControls
              layout={tab === 'library' ? layout : undefined}
              onLayoutChange={tab === 'library' ? setLayout : undefined}
              sort={sort}
              onSortChange={setSort}
              filters={filterOptions}
              filter={filters[tab]}
              onFilterChange={value => setFilters(current => ({ ...current, [tab]: value }))}
            />
            <LibrarySearch
              key={tab}
              query={query}
              onQueryChange={setQuery}
              placeholder={tab === 'chats' ? 'Search chats' : 'Search apps and files'}
            />
            <NewMenuButton>
              <DropdownMenu.Item onClick={startChat} className={MENU_ITEM}>Chat</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => navigate({ to: '/blueprints' })} className={MENU_ITEM}>From a template…</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={onInvite} className={MENU_ITEM}>Invite people…</DropdownMenu.Item>
            </NewMenuButton>
          </div>
        )}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'activity' ? '' : 'px-4 pb-24 pt-2.5 md:px-[45px] md:pb-8'}`}>
        {tab === 'chats' && (chats === null ? <Spinner /> : chatGroups.length === 0 ? (
          <Empty>
            {needle || chatFilter !== 'all' ? 'No chats match.' : (
              <>
                No chats yet.{' '}
                <button type="button" onClick={startChat} className="cursor-pointer font-medium text-kumo-default underline-offset-2 hover:underline">
                  Start one
                </button>
              </>
            )}
          </Empty>
        ) : (
          <div className="flex flex-col gap-2.5">
            {chatGroups.map((group, index) => (
              <div key={index} className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
                {group.map(row => {
                  const actions: MenuEntry[] = [
                    { label: 'Open', onSelect: () => onOpenChat(row.chat.id) },
                    { label: 'Rename', onSelect: () => setRenamingChat(row.chat.id) },
                    { label: row.starred ? 'Unstar' : 'Star', onSelect: () => starChat(row.chat, !row.starred) },
                    { label: row.unread > 0 ? 'Mark as read' : 'Mark as unread', onSelect: () => markChat(row) },
                    { label: row.archived ? 'Unarchive' : 'Archive', onSelect: () => archiveChat(row.chat, !row.archived) },
                    { label: 'Details', onSelect: () => navigate({ to: '/workspace/$id', params: { id: workspaceId }, search: { chat: row.chat.id, details: 'library' } }) },
                    'separator',
                    { label: 'Delete', danger: true, onSelect: () => setDeletingChat(row.chat) },
                  ]
                  return (
                    <ContextMenu key={row.chat.id} items={actions}>
                      <ChatRow
                        row={row}
                        renaming={renamingChat === row.chat.id}
                        onOpen={() => onOpenChat(row.chat.id)}
                        onToggleStar={() => starChat(row.chat, !row.starred)}
                        onRename={title => renameChat(row.chat, title)}
                        onRenameDone={() => setRenamingChat(null)}
                        menu={<DropdownMenuEntries items={actions} />}
                      />
                    </ContextMenu>
                  )
                })}
              </div>
            ))}
          </div>
        ))}

        {tab === 'library' && (files === null ? <Spinner /> : (
          <LibraryCollection
            items={libraryItems}
            layout={layout}
            grouping="favorites"
            onToggleStar={item => void setStarred(item.favorite, !item.starred)}
            empty={query ? 'Nothing matches your search.' : 'Apps made here and files added to its chats will show up here.'}
          />
        ))}

        {tab === 'automations' && (
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-2">
            <AutomationList
              overseer={overseer}
              scope="workspace"
              empty={<>Ask in any chat here for something to happen on a schedule, like &ldquo;Every Monday at 9, sum up last week&rsquo;s sales&rdquo;, and it shows up here.</>}
              originOf={hook => {
                if (hook.chatId !== undefined) {
                  const chatId = hook.chatId
                  const title = chats?.find(chat => chat.id === chatId)?.title ?? 'a chat'
                  return (
                    <button type="button" onClick={() => onOpenChat(chatId)}
                      className="cursor-pointer underline-offset-2 hover:text-kumo-subtle hover:underline focus-visible:underline focus-visible:outline-none">
                      In {title}
                    </button>
                  )
                }
                const app = gadgets.find(gadget => gadget.id === hook.gadgetId)
                return app ? `Runs ${app.title}` : undefined
              }}
            />
            <AgentList overseer={overseer} workspaceId={workspaceId} />
          </div>
        )}

        {tab === 'members' && (collaborators === null ? <Spinner /> : (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
              {members.map(member => (
                <MemberRow key={member.person.id} person={member.person} role={member.role} you={member.person.id === currentUser?.id} />
              ))}
            </div>
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={onInvite}
                className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85"
              >
                <UserPlusIcon size={16} />
                {isOwner ? 'Invite or manage access' : 'Invite people'}
              </button>
            </div>
          </div>
        ))}

        {tab === 'activity' && <div className="min-h-0 flex-1">{activity}</div>}
      </div>

      <DeleteConfirmationDialog
        open={deletingChat !== null}
        title="Delete chat?"
        description={<>This removes <span className="font-medium text-kumo-default">{deletingChat?.title}</span> for everyone in the workspace. You can&apos;t undo this.</>}
        isDeleting={deleting}
        onOpenChange={open => { if (!open) setDeletingChat(null) }}
        onConfirm={() => void deleteChat()}
      />
      <DeleteConfirmationDialog
        open={deletingWorkspace}
        title="Delete workspace?"
        description={<>This removes <span className="font-medium text-kumo-default">{metadata.title}</span> and everything in it. You can&apos;t undo this.</>}
        isDeleting={deleting}
        onOpenChange={setDeletingWorkspace}
        onConfirm={() => void deleteWorkspace()}
      />
    </SplitPage>
  )
}
