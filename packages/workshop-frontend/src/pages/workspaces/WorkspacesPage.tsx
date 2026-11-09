import { useMemo, useState } from 'react'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import type { AiChatAuthorInfo, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useDocumentTitle } from '../../useDocumentTitle'
import { logRpcFailure } from '../../rpcErrors'
import { PageHeader } from '../../components/PageHeader'
import { FolderBadge } from '../../components/icons/brandMarks'
import { FolderIcon, MoreIcon, StarIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { useWorkspaces, isMemberWorkspace } from '../../features/workspaces/WorkspacesContext'
import { workspaceInitials } from '../../features/workspaces/workspaceInitials'
import { CreateWorkspaceDialog } from '../../features/workspaces/CreateWorkspaceDialog'
import { MemberStack } from '../../features/workspaces/MemberStack'
import { useWorkspaceMembers } from '../../features/workspaces/useWorkspaceMembers'
import { WorkspaceNotificationsMenu } from '../../features/notifications/WorkspaceNotificationsMenu'
import { useRecentChats } from '../../features/recent-chats/useRecentChats'
import { StarFilledIcon } from '../../features/library/LibraryViews'
import {
  LibrarySearch,
  LibraryViewControls,
  NewMenuButton,
  type LibraryFilterOption,
  type LibrarySort,
} from '../../features/library/LibraryToolbar'

const FILTERS: LibraryFilterOption[] = [
  { value: 'all', label: 'All workspaces' },
  { value: 'mine', label: 'Created by me' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'unread', label: 'With unread chats' },
]

function WorkspaceRow({ workspace, unread, people, onTogglePin, onChanged }: {
  workspace: WorkspaceMetadataWithTimestamps
  unread: boolean
  people?: AiChatAuthorInfo[]
  onTogglePin: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const open = () => navigate({ to: '/workspace/$id', params: { id: workspace.id }, search: {} })
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
      }}
      className="group/row flex h-[59px] cursor-pointer items-center gap-3 rounded-[14px] px-3 outline-none transition-colors hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring"
    >
      <FolderBadge initials={workspaceInitials(workspace.title)} size={35} className="shrink-0 text-kumo-contrast" />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">{workspace.title}</span>
          {workspace.invited && (
            <span className="shrink-0 rounded-full bg-kumo-brand/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-kumo-brand">Invited</span>
          )}
          {unread && <span className="size-2 shrink-0 rounded-full bg-kumo-brand" aria-label="Unread chats" />}
        </span>
        {workspace.owner && (
          <span className="truncate text-[12px] leading-4 text-kumo-subtle">
            {workspace.invited ? `${workspace.owner.name} invited you` : `Shared by ${workspace.owner.name}`}
          </span>
        )}
      </span>
      {people && people.length > 0 && (
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          <MemberStack people={people} />
          <span className="text-[13px] font-medium leading-4 text-kumo-subtle">
            {people.length} {people.length === 1 ? 'member' : 'members'}
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={event => { event.stopPropagation(); onTogglePin() }}
        aria-label={workspace.pinned ? `Unstar ${workspace.title}` : `Star ${workspace.title}`}
        aria-pressed={workspace.pinned === true}
        className={`flex size-6 shrink-0 cursor-pointer items-center justify-center text-kumo-default transition-opacity focus-visible:opacity-100 focus-visible:outline-none ${
          workspace.pinned ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover/row:opacity-50 hover:!opacity-100'
        }`}
      >
        {workspace.pinned ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
      </button>
      <DropdownMenu>
        <DropdownMenu.Trigger render={
          <button
            type="button"
            onClick={event => event.stopPropagation()}
            aria-label={`More for ${workspace.title}`}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-kumo-default opacity-0 transition-opacity hover:!opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-hover/row:opacity-50 data-[popup-open]:opacity-100"
          >
            <MoreIcon size={16} />
          </button>
        } />
        <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
          <DropdownMenu.Item onClick={open} className={MENU_ITEM}>Open</DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/workspace/$id', params: { id: workspace.id }, search: { tab: 'members' } })}
            className={MENU_ITEM}
          >
            Members
          </DropdownMenu.Item>
          <WorkspaceNotificationsMenu workspaceId={workspace.id} mute={workspace.notificationMute} onMuteChange={onChanged} />
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

/**
 * Workspaces (Figma "MacBook Pro 14\" - 17"): the user's named workspaces, starred ones in a card
 * of their own above the rest, each with its people and whether it has unread chats.
 */
export function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { workspaces, loading, refresh } = useWorkspaces()
  const threads = useRecentChats(authenticatedApi)
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [pinned, setPinned] = useState<ReadonlyMap<string, boolean>>(new Map())

  const named = useMemo(() => workspaces.filter(isMemberWorkspace)
    .map(w => pinned.has(w.id) ? { ...w, pinned: pinned.get(w.id) } : w), [workspaces, pinned])
  // Asking an invited workspace for its members would open it, which should wait for the user.
  const opened = useMemo(() => named.filter(w => !w.invited), [named])
  const members = useWorkspaceMembers(opened, currentUser)
  const unreadWorkspaces = useMemo(() => new Set((threads ?? [])
    .filter(thread => thread.unreadMessageCount > 0).map(thread => thread.workspaceId)), [threads])

  const needle = query.trim().toLowerCase()
  const shown = named
    .filter(w => !needle || w.title.toLowerCase().includes(needle))
    .filter(w => filter === 'all' || (filter === 'mine' ? !w.owner : filter === 'shared' ? !!w.owner
      : unreadWorkspaces.has(w.id)))
    .toSorted(sort === 'name' ? (a, b) => a.title.localeCompare(b.title)
      : (a, b) => b.lastActive.getTime() - a.lastActive.getTime())
  const groups = [shown.filter(w => w.pinned), shown.filter(w => !w.pinned)].filter(g => g.length)

  const togglePin = async (workspace: WorkspaceMetadataWithTimestamps) => {
    const next = !workspace.pinned
    setPinned(current => new Map(current).set(workspace.id, next))
    try {
      await authenticatedApi.setWorkspacePinned(workspace.id, next)
      refresh()
    } catch (err) {
      logRpcFailure('Failed to pin workspace:', err)
      setPinned(current => { const copy = new Map(current); copy.delete(workspace.id); return copy })
      toasts.add({ title: next ? "Couldn't star the workspace" : "Couldn't unstar the workspace", variant: 'error' })
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader icon={<FolderIcon size={16} />} title="Workspaces">
        <div className="flex items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:bottom-4 max-md:z-10 max-md:justify-center">
          <LibraryViewControls
            sort={sort}
            onSortChange={setSort}
            filters={FILTERS}
            filter={filter}
            onFilterChange={setFilter}
          />
          <LibrarySearch query={query} onQueryChange={setQuery} placeholder="Search workspaces" />
          <NewMenuButton>
            <DropdownMenu.Item onClick={() => setCreating(true)} className={MENU_ITEM}>Workspace</DropdownMenu.Item>
          </NewMenuButton>
        </div>
      </PageHeader>
      <div className="flex-1 px-4 pb-24 pt-2.5 md:px-[45px] md:pb-8">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-[13px] leading-5 text-kumo-subtle">
              {needle || filter !== 'all' ? 'No workspaces match.' : 'Workspaces hold the chats, gadgets and files you share with others.'}
            </p>
            {!needle && filter === 'all' && (
              <button type="button" onClick={() => setCreating(true)}
                className="inline-flex h-[34px] cursor-pointer items-center rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85">
                Create a workspace
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {groups.map((group, index) => (
              <div key={index} className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
                {group.map(workspace => (
                  <WorkspaceRow
                    key={workspace.id}
                    workspace={workspace}
                    unread={unreadWorkspaces.has(workspace.id)}
                    people={members.get(workspace.id)?.people}
                    onTogglePin={() => void togglePin(workspace)}
                    onChanged={refresh}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

