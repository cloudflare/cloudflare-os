import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMetadata,
  ChatFileSummary,
  GadgetSummary,
  NotificationMute,
  Overseer,
  WorkpieceId,
  WorkspaceMetadata,
  AiChatAuthorInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { ChatConnections } from './ChatConnections'
import { useDocumentTitle } from '../../useDocumentTitle'
import { logRpcFailure } from '../../rpcErrors'
import { SplitPage } from '../../components/AppShell/SplitPage'
import { PageTabs } from '../../components/PageHeader'
import { RoundButton } from '../../components/RoundButton'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { SETTING_BUTTON, Setting, SettingsCard, SettingsDivider } from '../../components/settings/SettingsCard'
import { ArchiveIcon, ChevronLeftIcon, FolderIcon, ShareIcon, TrashIcon, UserPlusIcon } from '../../components/icons/designIcons'
import { MemberStack } from '../../features/workspaces/MemberStack'
import { InviteOrShareButton } from '../../features/chat-page/ChatPageChrome'
import { useRecentChats } from '../../features/recent-chats/useRecentChats'
import { LibraryCollection, type LibraryItem } from '../../features/library/LibraryViews'
import {
  LibrarySearch,
  LibraryViewControls,
  arrangeLibraryItems,
  type LibraryFilterOption,
  type LibrarySort,
} from '../../features/library/LibraryToolbar'
import { LibraryPreviewPane } from '../../features/library/LibraryPreviewPane'
import { useFavorites } from '../../features/library/useLibraryData'
import { useLibraryItems } from '../../features/library/useLibraryItems'
import { useLibraryLayout } from '../../features/library/useLibraryLayout'
import { describeMute } from '../../features/notifications/notificationMute'
import { AutomationList } from '../../features/automations/AutomationList'
import { AgentList } from '../../features/automations/AgentList'

/** A chat's details tabs (Figma "Frame 800"). */
export type ChatDetailsTab = 'library' | 'automations' | 'connections' | 'activity' | 'settings'

const TABS: { value: ChatDetailsTab; label: string }[] = [
  { value: 'library', label: 'Library' },
  { value: 'automations', label: 'Automations' },
  { value: 'connections', label: 'Connections' },
  { value: 'activity', label: 'Activity log' },
  { value: 'settings', label: 'Settings' },
]

const LIBRARY_FILTERS: LibraryFilterOption[] = [
  { value: 'all', label: 'Everything' },
  { value: 'app', label: 'Apps' },
  { value: 'file', label: 'Files' },
]

const formatTokens = (tokens: number) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
  : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens)

/**
 * A chat's details (Figma "MacBook Pro 14\" - 6", "- 7" and "- 8"): back to the chat, its
 * workspace and title, and tabs of what it holds, what it connects to, what it did, and its
 * settings.
 */
export function ChatDetailsPage({
  metadata,
  overseer,
  chat,
  gadgets,
  tab,
  onTabChange,
  onBack,
  onShare,
  onOpenApp,
  onDeleted,
  activity,
}: {
  metadata: WorkspaceMetadata
  overseer: RpcStub<Overseer>
  /** The chat, once the workspace's chats have loaded. */
  chat: AiChatMetadata | undefined
  gadgets: readonly GadgetSummary[]
  tab: ChatDetailsTab
  onTabChange: (tab: ChatDetailsTab) => void
  onBack: () => void
  onShare: () => void
  /** Opens one of the chat's apps beside it, as its drafts can only be seen from the chat. */
  onOpenApp: (workpieceId: WorkpieceId) => void
  onDeleted: () => void
  /** The Activity log tab's content, which the workspace's editor already holds. */
  activity: ReactNode
}) {
  const workspaceId = metadata.id
  const chatId = chat?.id
  useDocumentTitle(chat ? `${chat.title} · Details` : 'Details')
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const threads = useRecentChats(authenticatedApi)
  const { favorites, starred, setStarred } = useFavorites()
  const [layout, setLayout] = useLibraryLayout()
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [paneExpanded, setPaneExpanded] = useState(false)
  const [mute, setMute] = useState<NotificationMute | undefined>(metadata.notificationMute)
  useEffect(() => setMute(metadata.notificationMute), [metadata.notificationMute])
  const [archivedOverride, setArchivedOverride] = useState<boolean | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [savingMute, setSavingMute] = useState(false)
  // Who else can open the chat: everyone who works in its workspace. Null while loading.
  const [members, setMembers] = useState<AiChatAuthorInfo[] | null>(null)

  const [files, setFiles] = useState<ChatFileSummary[] | null>(null)
  const lastActive = chat?.lastActive.getTime()
  useEffect(() => {
    if (chatId === undefined) return
    let cancelled = false
    overseer.listChatFiles(chatId).then(
      list => { if (!cancelled) setFiles(list) },
      err => { logRpcFailure('Failed to list the chat\'s files:', err); if (!cancelled) setFiles(current => current ?? []) })
    return () => { cancelled = true }
  }, [overseer, chatId, lastActive])

  useEffect(() => {
    let cancelled = false
    overseer.listCollaborators().then(
      list => {
        if (!cancelled) setMembers(list.filter(c => c.access.role === 'build').map(c => c.profile))
      },
      err => { logRpcFailure('Failed to list workspace members:', err); if (!cancelled) setMembers([]) })
    return () => { cancelled = true }
  }, [overseer, metadata.owner?.id])

  // The chat's apps: the ones it built, kept or still drafts, and the apps it is changing.
  const chatApps = useMemo(() => chat === undefined ? [] : gadgets.filter(g =>
    g.chatId === chat.id || g.madeInChatId === chat.id
      || (chat.proposedChangeWorkpieces ?? []).includes(g.id)), [gadgets, chat])

  const chatAppIds = useMemo(() => chatApps.map(app => app.id), [chatApps])
  const appSources = useMemo(() => chatApps.map(app => ({
    workspaceId, workpieceId: app.id, title: app.title, output: app.output, date: chat?.lastActive ?? new Date(0),
  })), [chatApps, workspaceId, chat?.lastActive])
  const fileSources = useMemo(() => (files ?? []).map(file => ({ ...file, workspaceId })), [files, workspaceId])
  const { appItems, fileItems, preview, setPreview } = useLibraryItems({
    apps: appSources, files: fileSources, favorites: favorites ?? [], starred, showContext: false,
  })
  const items: LibraryItem[] = useMemo(() => arrangeLibraryItems([
    // A chat's apps open beside it, where its drafts can be seen.
    ...appItems.map(item => item.favorite.kind === 'app'
      ? { ...item, onOpen: () => onOpenApp((item.favorite as { workpieceId: WorkpieceId }).workpieceId) }
      : item),
    ...fileItems,
  ].filter(item => filter === 'all' || item.kind === filter), sort, query), [appItems, fileItems, filter, sort, query, onOpenApp])

  const thread = threads?.find(t => t.workspaceId === workspaceId && t.chatId === chatId)
  const archived = archivedOverride ?? thread?.archived === true
  const muted = mute !== undefined && ('indefinite' in mute || mute.until.getTime() > Date.now())
  const named = metadata.kind === 'workspace'

  const setNotifications = async (enabled: boolean) => {
    const next: NotificationMute | null = enabled ? null : { indefinite: true }
    setSavingMute(true)
    try {
      await authenticatedApi.setWorkspaceNotificationMute(workspaceId, next)
      setMute(next ?? undefined)
    } catch (err) {
      logRpcFailure('Failed to change notifications:', err)
      toasts.add({ title: "Couldn't change notifications", variant: 'error' })
    } finally {
      setSavingMute(false)
    }
  }
  const setArchived = async (archive: boolean) => {
    if (chatId === undefined) return
    setArchivedOverride(archive)
    try {
      await authenticatedApi.setChatArchived(workspaceId, chatId, archive)
      toasts.add({ title: archive ? 'Chat archived' : 'Chat unarchived' })
    } catch (err) {
      logRpcFailure('Failed to archive chat:', err)
      setArchivedOverride(null)
      toasts.add({ title: archive ? "Couldn't archive the chat" : "Couldn't unarchive the chat", variant: 'error' })
    }
  }
  const deleteChat = async () => {
    if (chatId === undefined) return
    setDeleting(true)
    try {
      await overseer.deleteChat(chatId)
      setDeleteOpen(false)
      onDeleted()
    } catch (err) {
      logRpcFailure('Failed to delete chat:', err)
      toasts.add({ title: "Couldn't delete the chat", variant: 'error' })
      setDeleting(false)
    }
  }

  const owner = metadata.owner ?? currentUser
  const people = members === null ? null
    : [...(owner ? [owner] : []), ...members.filter(person => person.id !== owner?.id)]
  const others = people?.filter(person => person.id !== currentUser?.id).length ?? 0
  const usage = chat?.totalTokens
    ? `${formatTokens(chat.totalTokens)} tokens${chat.totalCost ? ` · $${chat.totalCost.toFixed(2)}` : ''}`
    : null

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
      <div className="flex h-[68px] shrink-0 items-center gap-2.5 p-3 max-md:px-4 md:h-[58px]">
        <RoundButton label="Back to chat" shape="pill" onClick={onBack} className="!gap-2 !pl-2.5 !pr-2.5 max-md:h-11">
          <ChevronLeftIcon size={14} className="opacity-50" />
          Back to chat
        </RoundButton>
        <span className="flex-1" />
        <InviteOrShareButton workspace={{ title: metadata.title, named }} onShare={onShare} className="max-md:!size-11" />
      </div>

      <div className="mt-2.5 flex flex-1 flex-col items-center gap-2.5 px-4 pb-24 pt-3 md:px-3 md:pb-8">
        {named && (
          <button
            type="button"
            onClick={() => navigate({ to: '/workspace/$id', params: { id: workspaceId }, search: {} })}
            className="flex cursor-pointer items-center gap-1 text-[13px] leading-4 text-kumo-subtle hover:text-kumo-default"
          >
            <FolderIcon size={15} />
            {metadata.title}
          </button>
        )}
        <h1 className="min-h-[44px] max-w-[640px] text-center text-[18px] font-medium leading-[22px] text-kumo-default">
          {chat?.title ?? ' '}
        </h1>
        <div className="flex max-w-full justify-center pb-4">
          <PageTabs label="Chat details" tabs={TABS} value={tab} onChange={onTabChange} />
        </div>

        <div className={`flex w-full min-h-0 flex-col ${tab === 'activity' ? 'flex-1 md:max-w-[880px]' : 'max-w-[640px]'}`}>
          {tab === 'library' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <LibrarySearch query={query} onQueryChange={setQuery} placeholder="Search this chat" />
                <span className="flex-1" />
                <LibraryViewControls
                  layout={layout}
                  onLayoutChange={setLayout}
                  sort={sort}
                  onSortChange={setSort}
                  filters={LIBRARY_FILTERS}
                  filter={filter}
                  onFilterChange={setFilter}
                />
              </div>
              {files === null ? (
                <div className="flex justify-center py-16">
                  <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
                </div>
              ) : (
                <LibraryCollection
                  items={items}
                  layout={layout}
                  grouping="recency"
                  onToggleStar={item => void setStarred(item.favorite, !item.starred)}
                  empty={query ? 'Nothing matches your search.' : 'Files added to this chat and apps it makes will show up here.'}
                />
              )}
            </div>
          )}

          {tab === 'automations' && chat && (
            <div className="flex flex-col gap-2">
              <AutomationList
                overseer={overseer}
                scope={{ chatId: chat.id, gadgetIds: chatAppIds }}
                empty={<>Ask in this chat for something to happen on a schedule, like &ldquo;Every weekday at 9, summarize my inbox&rdquo;, and it shows up here.</>}
              />
              <AgentList overseer={overseer} workspaceId={workspaceId} gadgetIds={chatAppIds} chatId={chat.id} />
            </div>
          )}

          {tab === 'connections' && chat && <ChatConnections overseer={overseer} apps={chatApps} chatId={chat.id} />}

          {tab === 'activity' && <div className="min-h-[480px] flex-1 overflow-hidden rounded-[20px] ring-1 ring-kumo-line">{activity}</div>}

          {tab === 'settings' && (
            <div className="flex flex-col gap-2.5">
              <SettingsCard>
                <Setting
                  title="Notifications"
                  description={named
                    ? <>Get notified when things are happening in this chat. This applies to every chat in {metadata.title}.</>
                    : 'Get notified when things are happening in this chat'}
                >
                  <span className="text-[14px] font-medium leading-[17px] text-kumo-default">
                    {muted ? describeMute(mute) ?? 'Muted' : 'Enabled'}
                  </span>
                  <Switch
                    aria-label="Notifications"
                    checked={!muted}
                    disabled={savingMute}
                    onCheckedChange={enabled => void setNotifications(enabled)}
                  />
                </Setting>
                <SettingsDivider />
                <Setting
                  title="Who can see this"
                  description={named
                    ? <>Everyone in {metadata.title} can open its chats and work in them with you. Connections that protect data still ask each person for their own access.</>
                    : 'Only the people you share this chat with. They can read it, carry it on with you and use its apps.'}
                >
                  {people && (
                    <span className="flex items-center gap-2">
                      {others > 0 && <MemberStack people={people} />}
                      <span className="text-[14px] leading-[17px] text-kumo-default">
                        {others === 0 ? 'Only you' : `You and ${others} ${others === 1 ? 'other' : 'others'}`}
                      </span>
                    </span>
                  )}
                  {metadata.role !== 'use' && (
                    <button type="button" onClick={onShare} className={`${SETTING_BUTTON} text-kumo-default`}>
                      {named ? <UserPlusIcon size={14} /> : <ShareIcon size={14} />}
                      {named ? 'Invite' : 'Share'}
                    </button>
                  )}
                </Setting>
                <SettingsDivider />
                <Setting
                  title={archived ? 'Unarchive chat' : 'Archive chat'}
                  description={archived
                    ? 'This chat is left out of your recents. Unarchive it to bring it back.'
                    : 'This chat won’t show up in your recents, but will be still discoverable via search and history.'}
                >
                  <button type="button" onClick={() => void setArchived(!archived)} className={`${SETTING_BUTTON} text-kumo-default`}>
                    <ArchiveIcon size={14} />
                    {archived ? 'Unarchive' : 'Archive'}
                  </button>
                </Setting>
                {usage && (
                  <>
                    <SettingsDivider />
                    <Setting title="Usage" description="What the AI has used in this chat so far.">
                      <span className="text-[14px] leading-[17px] text-kumo-default">{usage}</span>
                    </Setting>
                  </>
                )}
              </SettingsCard>
              <SettingsCard>
                <Setting
                  title="Delete chat"
                  danger
                  description={<>Delete chat completely, so it will not be accessible anymore. <span className="text-kumo-default">This is not reversible.</span></>}
                >
                  <button type="button" onClick={() => setDeleteOpen(true)} disabled={chat === undefined}
                    className={`${SETTING_BUTTON} text-kumo-danger`}>
                    <TrashIcon size={14} />
                    Delete
                  </button>
                </Setting>
              </SettingsCard>
            </div>
          )}
        </div>
      </div>

      <DeleteConfirmationDialog
        open={deleteOpen}
        title="Delete chat?"
        description={<>This removes <span className="font-medium text-kumo-default">{chat?.title}</span>{named ? ' for everyone in the workspace' : ''}. You can&apos;t undo this.</>}
        isDeleting={deleting}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void deleteChat()}
      />
    </SplitPage>
  )
}
