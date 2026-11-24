import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createFileRoute, Outlet, useLocation, useMatch, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { asideItemFor, carriedOpen, formatAsideRef, itemPageId, keptVersion, pageOf, parseAsideRef, parseItemPageId, type AsideItem, type AsideOutput } from '@/aside/asideItems'
import { AsidePane, EmptyAsidePane } from '@/aside/AsidePane'
import { lastShown, rememberShown } from '@/aside/lastShown'
import { carryAside, useAsideNavigation, type BesideRef } from '@/aside/useAsideNavigation'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { waitingCountsOf, waitingWords } from '@/workspaces/waitingWords'
import { ConnectionIsland, type ConnectionIslandState } from '@/blocks/ConnectionIsland'
import { SettingsSidebar } from '@/blocks/SettingsSidebar'
import { Sidebar, type SidebarActions, type SidebarChat, type SidebarWorkspace } from '@/blocks/Sidebar'
import { ChatSessionsProvider } from '@/chat/ChatSessionsProvider'
import { totalGadgetAsks } from '@/workspaces/WorkspaceSummaries'
import { useWorkspaceSummaries } from '@/workspaces/WorkspaceSummariesContext'
import { WorkspaceSummariesProvider } from '@/workspaces/WorkspaceSummariesProvider'
import { OutputsFeedProvider } from '@/library/OutputsFeedProvider'
import { formatActivity, useNarrowScreen } from '@gadgets/ui'
import { usePreferences, usePreferencesSnapshot } from '@/prefs/UserPreferencesContext'
import { UserPreferencesProvider } from '@/rpc/UserPreferencesProvider'
import { AppShell } from '@/layouts/AppShell'
import { NarrowShell } from '@/layouts/NarrowShell'
import { useUnread } from '@/notifications/UnreadContext'
import { UnreadProvider } from '@/notifications/UnreadProvider'
import { useBrowserPushSync } from '@/notifications/useBrowserPush'
import { useTaskNotices } from '@/notifications/useTaskNotices'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { useApi } from '@/rpc/ApiContext'
import { signOut } from '@/rpc/signOut'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { FeatureFlagsProvider } from '@/rpc/FeatureFlagsProvider'
import { RpcGate } from '@/rpc/RpcGate'
import { useClassicUiFallback } from '@/rpc/useClassicUiFallback'
import { useServerConfig } from '@/rpc/serverConfig'
import { sharedConnection } from '@/rpc/sharedConnection'
import { useIsAdmin } from '@/settings/admin/useIsAdmin'
import { SiteFrame } from '@/rpc/SiteFrame'
import { siteLogoUrl } from '@/rpc/siteLook'
import { OnboardingGate } from '@/settings/OnboardingGate'
import { FIRST_SECTION, isSettingsSection, settingsNavGroups } from '@/settings/settingsSections'
import { useOwnAvatar } from '@/settings/useOwnAvatar'
import { ShareLinkGate } from '@/workspaces/ShareLinkGate'
import { useSetWorkspaceMuted, useSetWorkspacePinned, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
import { recentChatKey } from '@/workspaces/recentChats'
import { keepStarredOrder, orderStarred } from '@/workspaces/starredOrder'
import { useRecentChats } from '@/workspaces/useRecentChats'
import { useGhostChats, type GhostChat } from '@/workspaces/useGhostChats'
import { isWorkspaceMuted } from '@/workspaces/workspaceMute'
import { RecentChatsProvider } from '@/workspaces/RecentChatsProvider'
import { useLiveWorkspace } from '@/workspaces/useLiveWorkspace'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { chatTitle } from '@/workspaces/chatList'
import { joinedWorkspaces, workspaceTitle } from '@/workspaces/workspaceList'
import { ObserverAccessProvider, usePageAccessQuestion } from '@/connections/ObserverAccessProvider'
import { sidebarConnections } from '@/connections/sidebarConnections'
import { useConnections } from '@/connections/useConnections'
import { GatekeeperAppsProvider } from '@/gatekeeperApps/GatekeeperAppsProvider'
import { useGatekeeperApps } from '@/gatekeeperApps/GatekeeperAppsContext'
import { AppSearch, type SearchContext } from './-AppSearch'

/** Everything under here needs the backend; routes outside it (the gallery) work without one. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <SiteFrame>
      <RpcGate connection={sharedConnection()}>
        {/* Outermost, so that whatever opens a workspace asks the user to confirm their access where it must. */}
        <ObserverAccessProvider>
          <FeatureFlagsProvider>
            <ClassicUiFallback />
            {/* A new user is set up before anything else is read for them. */}
            <OnboardingGate>
              {/* Before the workspaces are listed, so that one a link let the user in to is among them. */}
              <ShareLinkGate>
                <WorkspacesProvider>
                  <UnreadProvider>
                    <WorkspaceSummariesProvider>
                      <UserPreferencesProvider>
                        <RecentChatsProvider>
                          <ChatSessionsProvider>
                            <OutputsFeedProvider>
                              <GatekeeperAppsProvider>
                                <AppFrame />
                              </GatekeeperAppsProvider>
                            </OutputsFeedProvider>
                          </ChatSessionsProvider>
                        </RecentChatsProvider>
                      </UserPreferencesProvider>
                    </WorkspaceSummariesProvider>
                  </UnreadProvider>
                </WorkspacesProvider>
              </ShareLinkGate>
            </OnboardingGate>
          </FeatureFlagsProvider>
        </ObserverAccessProvider>
      </RpcGate>
    </SiteFrame>
  ),
})

// Back to the old UI for a user the `workshop-app` flag is off for (see `useClassicUiFallback`).
const ClassicUiFallback = () => {
  useClassicUiFallback()
  return null
}

// How many of the latest workspaces the sidebar lists while it has nothing pinned and no recent chats.
const FALLBACK_WORKSPACES = 8

const absolute = (href: string) => new URL(href, window.location.origin).href

/**
 * The frame, laid out for the page the URL names (see `AppShell`): beside a chat or a workspace's
 * page, what it names there (`?open=`); as an item's own page (an app's, or one in the library), the item alone. Both are the same card, so going from
 * one to the other keeps what is in it running.
 *
 * On a narrow screen there is room for one thing at a time (see `NarrowShell`): the sidebar is
 * beneath the page, and what is beside a chat comes over it.
 */
const AppFrame = () => {
  const { user } = useApi()
  const avatarUrl = useOwnAvatar()
  const config = useServerConfig()
  const connection = useConnectionNotice()!
  const connectionState = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const workspacesState = useWorkspaces()
  const unread = useUnread()
  const looks = useWorkspaceLooks()
  const summaries = useWorkspaceSummaries()
  const preferences = usePreferences()
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  const { workspaceId: pathWorkspaceId } = useParams({ strict: false })
  const [prefs] = useState(readLayoutPrefs)
  const narrow = useNarrowScreen()
  // Whether the deployment's own settings are listed after the user's.
  const admin = useIsAdmin()
  // The logos on the sidebar's connect button, once the services are read.
  const { state: connectionsState } = useConnections()
  const connectionLogos = connectionsState.status === 'ready' ? sidebarConnections(connectionsState.connections) : undefined
  const gatekeeperApps = useGatekeeperApps()

  const homePage = useMatch({ from: '/_app/', shouldThrow: false })
  const workspacePage = useMatch({ from: '/_app/workspace/$workspaceId/', shouldThrow: false })
  const chatPage = useMatch({ from: '/_app/workspace/$workspaceId/chat/$chatId', shouldThrow: false })
  // A new chat in a workspace is home, with the workspace chosen.
  const newChatIn = homePage?.search.workspace
  const workspaceId = pathWorkspaceId ?? newChatIn
  const appPage = useMatch({ from: '/_app/app/$itemId', shouldThrow: false })
  const libraryItemPage = useMatch({ from: '/_app/library/$itemId', shouldThrow: false })
  const libraryPage = useMatch({ from: '/_app/library/', shouldThrow: false })
  // The templates are come to from the library, and are part of it.
  const templatesPage = useMatch({ from: '/_app/library/templates/', shouldThrow: false })
  const templatePage = useMatch({ from: '/_app/library/templates/$templateId', shouldThrow: false })
  const workspacesPage = useMatch({ from: '/_app/workspaces', shouldThrow: false })
  const automationsPage = useMatch({ from: '/_app/automations', shouldThrow: false })
  const gatekeeperAppPage = useMatch({ from: '/_app/apps/$appId', shouldThrow: false })
  const connectionsPage = useMatch({ from: '/_app/connections', shouldThrow: false })
  const settingsPage = useMatch({ from: '/_app/settings', shouldThrow: false })
  const inSettings = settingsPage !== undefined
  const itemPage = appPage ?? libraryItemPage
  const pageItem = itemPage && parseItemPageId(itemPage.params.itemId)
  // The workspace that is open, whose title and the viewer's role in it are kept live.
  useLiveWorkspace(workspaceId ?? pageItem?.workspaceId)

  // Beside a chat, a chat that is still to be made, or a workspace's own page: which is named.
  const besideOf: { workspaceId: string; open: string | undefined } | undefined = chatPage
    ? { workspaceId: chatPage.params.workspaceId, open: chatPage.search.open }
    : newChatIn !== undefined
      ? { workspaceId: newChatIn, open: homePage?.search.open }
      : workspacePage && { workspaceId: workspacePage.params.workspaceId, open: workspacePage.search.open }
  const chatId = chatPage?.params.chatId
  const chatRef = chatPage && { workspaceId: chatPage.params.workspaceId, chatId: chatPage.params.chatId }
  // The page that has its workspace's library to show beside it: a chat, or the workspace's own,
  // where what was made is shown as it stands, with no chat's changes.
  const besideRef: BesideRef | undefined = chatRef ?? (workspacePage && { workspaceId: workspacePage.params.workspaceId })
  // Where what is shown comes from: the page it is beside, or the chat an item's own page names,
  // which says what the item is (a file's name and type) and where its bytes are.
  const pageChatId = itemPage?.search.chat
  const shownFrom = besideRef ?? (pageItem && pageChatId !== undefined ? { workspaceId: pageItem.workspaceId, chatId: pageChatId } : undefined)
  const named = besideOf && parseAsideRef(besideOf.open)
  // The aside, had back beside a page that has shown nothing of what it has: open with nothing in
  // it while the library is read, until something turns up. Kept for that page alone.
  const besideRefWorkspaceId = besideRef?.workspaceId
  const besideKey = besideRefWorkspaceId === undefined ? undefined : chatId === undefined ? besideRefWorkspaceId : `${besideRefWorkspaceId}/${chatId}`
  const [openedEmptyAt, setOpenedEmptyAt] = useState<string>()
  if (openedEmptyAt !== undefined && (named || openedEmptyAt !== besideKey)) setOpenedEmptyAt(undefined)
  const openedEmpty = besideKey !== undefined && !named && openedEmptyAt === besideKey
  const library = useChatLibrary(shownFrom)
  const { items, known } = library

  // What was made last, once the library has been read.
  const firstFound = openedEmpty ? items[0]?.key : undefined
  useEffect(() => {
    if (firstFound !== undefined && besideRefWorkspaceId !== undefined) aside.show(firstFound, { workspaceId: besideRefWorkspaceId, chatId })
  }, [firstFound, besideRefWorkspaceId, chatId, aside])
  const hideEmpty = () => {
    writeLayoutPrefs({ asideOpen: false })
    setOpenedEmptyAt(undefined)
  }

  // Full screen belongs to the page it was asked for on, so it is left behind with it, and with
  // what it filled the window with: an item's page, or what is shown beside a chat or a workspace.
  const [fullScreenAt, setFullScreenAt] = useState<string>()
  const [setFullScreen] = useState(() => (on: boolean) => setFullScreenAt(on ? router.state.location.pathname : undefined))
  const pathname = useLocation({ select: (location) => location.pathname })
  // A narrow screen is filled already.
  const fillable = !narrow && (pageItem !== undefined || (besideOf !== undefined && named !== undefined))
  if (fullScreenAt !== undefined && (fullScreenAt !== pathname || !fillable)) setFullScreenAt(undefined)
  const fullScreen = fillable && fullScreenAt === pathname
  // What is shown beside a chat or a workspace taking all of the page's room, from the divider
  // dragged all the way over, as the chat has it still. Left behind with the page, as full screen is.
  const [expandedAt, setExpandedAt] = useState<string>()
  const [setExpanded] = useState(() => (on: boolean) => setExpandedAt(on ? router.state.location.pathname : undefined))
  const expandable = !narrow && besideOf !== undefined && named !== undefined
  if (expandedAt !== undefined && (expandedAt !== pathname || !expandable)) setExpandedAt(undefined)
  const expanded = expandable && expandedAt === pathname
  // The sidebar out over a narrow screen, which, like full screen, is left behind with the page:
  // going anywhere puts it away.
  const [sidebarAt, setSidebarAt] = useState<string>()
  // Search is open, over whatever page it was opened from.
  const [searching, setSearching] = useState(false)
  const sidebarOpen = sidebarAt === pathname
  const leaveSidebar = () => setSidebarAt(undefined)
  // Up from an item's own page on a narrow screen, to what it is in: the chat it was shown from,
  // or the Library page it was opened from, or else its workspace's library.
  const up = () => {
    if (!pageItem) return
    if (pageChatId !== undefined) return void navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: pageItem.workspaceId, chatId: pageChatId } })
    if (router.state.location.state.fromLibrary) return void navigate({ to: '/library' })
    void navigate({ to: '/workspace/$workspaceId', params: { workspaceId: pageItem.workspaceId }, search: { tab: 'library' } })
  }

  // Its own page, as everyone sees it: a file names the chat it was sent in, which its bytes are
  // fetched through, and an output names none, as a chat's changes are only beside that chat.
  const linkTo = (inWorkspace: string, item: AsideItem, fromChat: number | undefined) =>
    absolute(router.buildLocation({ ...pageOf(inWorkspace, item), search: { chat: item.kind === 'file' ? fromChat : undefined } }).href)

  // A gadget's own settings, which the way back from comes back to. Only for whoever may build in
  // its workspace, which they are about; the server checks again.
  const builds = (inWorkspace: string) =>
    workspacesState.status === 'ready' && workspacesState.workspaces.some(({ id, role }) => id === inWorkspace && role !== 'use')
  const openSettings = (output: AsideOutput, title: string) =>
    navigate({
      to: '/app/$itemId/settings',
      params: { itemId: itemPageId(output.workspaceId, { kind: 'output', workpieceId: output.workpieceId }) },
      search: {},
      state: { fromItem: true, gadgetTitle: title },
    })
  // The chat an update from a gadget's template was proposed in, with the gadget beside it, showing it.
  const openUpdate = (output: AsideOutput, chatId: number) =>
    navigate({
      to: '/workspace/$workspaceId/chat/$chatId',
      params: { workspaceId: output.workspaceId, chatId },
      search: { open: formatAsideRef({ kind: 'output', workpieceId: output.workpieceId }) },
    })

  let asideElement: ReactNode = null
  // What is shown beside the page takes all of its room from the divider dragged all the way over.
  let expandAside: (() => void) | undefined
  if (itemPage && pageItem) {
    const { workspaceId: pageWorkspaceId, ref } = pageItem
    const { chat: fromChat } = itemPage.search
    // As it is kept: the chat it was opened from is only the way back to it.
    const item = keptVersion(asideItemFor(pageWorkspaceId, ref, fromChat, known))
    const open = formatAsideRef(ref)
    // Opened from beside the chat, going back is back there as it was; opened with a chat named
    // otherwise, such as by a link, it is going to that chat with it beside it.
    const openedHere = router.state.location.state.fromChat === true
    const toChat = (chat: { id: number; title?: string }) => {
      rememberShown(preferences, pageWorkspaceId, chat.id, open)
      void navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: pageWorkspaceId, chatId: chat.id }, search: { open }, state: { chatTitle: chat.title } })
    }
    asideElement = (
      <AsidePane
        placement="page"
        item={item}
        link={linkTo(pageWorkspaceId, item, fromChat)}
        fullScreen={fullScreen}
        onFullScreenChange={setFullScreen}
        narrow={narrow}
        onOpenSettings={builds(pageWorkspaceId) ? openSettings : undefined}
        onUpdateProposed={openUpdate}
        // Its workspace's library, which it was one of; in place, as it is no longer there to go back to.
        onDeleted={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: pageWorkspaceId }, search: { tab: 'library' }, replace: true })}
        // On a narrow screen, where it is beside nothing, it goes up.
        onBack={narrow ? up : undefined}
        fromChat={fromChat === undefined ? undefined : { chatId: fromChat, onBack: openedHere ? () => router.history.back() : () => toChat({ id: fromChat }) }}
        onOpenChat={toChat}
        onNewChat={(gadgetTitle) => navigate({ to: '/', search: { workspace: pageWorkspaceId, open }, state: { gadgetTitle } })}
      />
    )
  } else if (besideOf && named) {
    const item = asideItemFor(besideOf.workspaceId, named, chatId, known)
    const { workspaceId: besideWorkspaceId } = besideOf
    expandAside = () => setExpanded(true)
    asideElement = (
      <AsidePane
        placement="beside"
        item={item}
        link={linkTo(besideWorkspaceId, item, chatId)}
        fullScreen={fullScreen}
        onFullScreenChange={setFullScreen}
        narrow={narrow}
        onUpdateProposed={openUpdate}
        onDeleted={aside.hide}
        onHide={aside.hide}
        expanded={expanded}
        onShrink={() => setExpanded(false)}
        // Its page names the chat, which it goes back to, and a file is fetched through.
        onOpenPage={() => navigate({ ...pageOf(besideWorkspaceId, item), search: { chat: chatId }, state: { fromChat: true } })}
      />
    )
  } else if (openedEmpty) {
    asideElement = <EmptyAsidePane reading={library.reading} problem={library.problem} onRetry={library.retry} onHide={hideEmpty} narrow={narrow} />
  }

  // Each workspace the user is in is listed by its title and when it was last active, or what waits
  // on the user in it, and marked while it has anything unread.
  const joined = workspacesState.status === 'ready' ? joinedWorkspaces(workspacesState.workspaces) : []
  const joinedById = new Map(joined.map((workspace) => [workspace.id, workspace]))
  const workspaceHref = (id: string) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId: id } }).href
  const sidebarWorkspaceOf = (workspace: (typeof joined)[number]): SidebarWorkspace => {
    const { id, lastActive } = workspace
    const title = workspaceTitle(workspace)
    return {
      id,
      title,
      workspaceLabel: workspaceLabel(title),
      workspaceLook: looks[id],
      subtitle: formatActivity(lastActive),
      attention: waitingWords(waitingCountsOf(summaries.workspaces.get(id))),
      unread: unread?.totals.workspaces.has(id),
      href: workspaceHref(id),
      pinned: workspace.pinned === true,
      muted: isWorkspaceMuted(workspace),
    }
  }
  // The viewer's recent chats, each with its workspace, for whoever is in it.
  const recentChats = useRecentChats()
  const recentById = new Map(recentChats.chats.map((chat) => [chat.key, chat]))
  const chatHref = (inWorkspace: string, chat: number) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: inWorkspace, chatId: chat } }).href
  // A chat open that is not among them is listed first while it is, faintly until something is said in it.
  const openedTitle = useLocation({ select: (location) => location.state.chatTitle })
  const ghosts = useGhostChats(
    chatPage && { workspaceId: chatPage.params.workspaceId, chatId: chatPage.params.chatId, title: openedTitle },
    (key) => recentById.has(key),
  )
  const ghostById = new Map(ghosts.map((ghost) => [ghost.key, ghost]))
  const ghostChatOf = (ghost: GhostChat): SidebarChat[] => {
    const workspace = joinedById.get(ghost.workspaceId)
    if (!workspace) return []
    return [{
      id: ghost.key,
      workspaceId: ghost.workspaceId,
      title: chatTitle({ title: ghost.title ?? '' }),
      workspaceTitle: workspaceTitle(workspace),
      workspaceLabel: workspaceLabel(workspaceTitle(workspace)),
      workspaceLook: looks[workspace.id],
      preview: ghost.preview,
      previewLoading: ghost.loading,
      speaker: ghost.speaker,
      working: ghost.working,
      workspaceMuted: isWorkspaceMuted(workspace),
      workspacePinned: workspace.pinned === true,
      ghost: ghost.fresh ? 'active' : 'quiet',
      href: chatHref(ghost.workspaceId, ghost.chatId),
      workspaceHref: workspaceHref(ghost.workspaceId),
    }]
  }
  const sidebarChats: SidebarChat[] = [...ghosts.flatMap(ghostChatOf), ...recentChats.chats.flatMap((chat) => {
    const workspace = joinedById.get(chat.workspaceId)
    if (!workspace) return []
    const author = chat.latest?.author
    return [{
      id: chat.key,
      workspaceId: chat.workspaceId,
      title: chatTitle(chat),
      workspaceTitle: workspaceTitle(workspace),
      workspaceLabel: workspaceLabel(workspaceTitle(workspace)),
      workspaceLook: looks[workspace.id],
      preview: chat.latest?.text,
      // A chat's own assistant is not named: it is whose the chat is.
      speaker: author?.type === 'user' ? (author.id === user.id ? 'You' : author.name) : chat.agent,
      working: chat.working,
      unread: chat.unread,
      muted: chat.muted,
      workspaceMuted: isWorkspaceMuted(workspace),
      workspacePinned: workspace.pinned === true,
      href: chatHref(chat.workspaceId, chat.chatId),
      workspaceHref: workspaceHref(chat.workspaceId),
    }]
  })]
  // The pinned workspaces, in the order the Workspaces page has them; with none of them and no recent
  // chats to list either, the latest workspaces, as the sidebar had before there were chats in it.
  const { starredWorkspaces } = usePreferencesSnapshot()
  const pinnedWorkspaces = orderStarred(joined.filter(({ pinned }) => pinned), starredWorkspaces).map(sidebarWorkspaceOf)
  const workspaces = pinnedWorkspaces.length === 0 && sidebarChats.length === 0 && recentChats.known
    ? joined.slice(0, FALLBACK_WORKSPACES).map(sidebarWorkspaceOf)
    : []
  const selectedChatId = chatPage ? recentChatKey(chatPage.params.workspaceId, chatPage.params.chatId) : undefined
  // Each puts the sidebar away on a narrow screen, even where it goes to the page it is over.
  const openWorkspace = (id: string) => {
    leaveSidebar()
    // What is shown beside one of the workspace's pages stays beside its own.
    const open = besideOf?.workspaceId === id ? carryAside(preferences, besideOf.open, { workspaceId: id }) : undefined
    void navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id }, search: { open } })
  }
  const openChat = (chat: SidebarChat) => {
    const recent = recentOf(chat) ?? ghostById.get(chat.id)
    if (!recent) return
    leaveSidebar()
    const open = besideOf?.workspaceId === recent.workspaceId ? carryAside(preferences, besideOf.open, { workspaceId: recent.workspaceId, chatId: recent.chatId }) : undefined
    void navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: recent.workspaceId, chatId: recent.chatId }, search: { open }, state: { chatTitle: recent.title } })
  }
  const setPinned = useSetWorkspacePinned()
  const setWorkspaceMuted = useSetWorkspaceMuted()
  // What a sidebar menu asked for and could not be done, said under the list until the next.
  const [sidebarProblem, setSidebarProblem] = useState<string>()
  const attempt = (what: string, act: () => Promise<unknown> | void) => {
    if (connection.blocked()) return
    setSidebarProblem(undefined)
    Promise.resolve().then(act).catch((error: unknown) => setSidebarProblem(`Couldn’t ${what}: ${error instanceof Error ? error.message : String(error)}`))
  }
  const recentOf = (chat: SidebarChat) => recentById.get(chat.id)
  const sidebarActions: SidebarActions = {
    onOpenWorkspace: (id) => openWorkspace(id),
    onPinWorkspace: (id, pinned, at = 0) => attempt(pinned ? 'pin the workspace' : 'unpin the workspace', () => {
      // Where it was dropped among the pinned as they are shown, else first, as the latest pinned is on the Workspaces page.
      const order = pinnedWorkspaces.map((workspace) => workspace.id).filter((other) => other !== id)
      if (pinned) order.splice(Math.min(at, order.length), 0, id)
      keepStarredOrder(preferences, order)
      return setPinned(id, pinned)
    }),
    onMuteWorkspace: (id, muted) => attempt(muted ? 'mute the workspace' : 'unmute the workspace', () => setWorkspaceMuted(id, muted)),
    onMarkWorkspaceRead: unread === null ? undefined : (id) => attempt('mark the workspace read', () => unread.markWorkspaceRead(id)),
    onNewChat: (id) => {
      leaveSidebar()
      void navigate({ to: '/', search: { workspace: id } })
    },
    onMuteChat: (chat, muted) => attempt(muted ? 'mute the chat' : 'unmute the chat', () => {
      const recent = recentOf(chat)
      return recent && recentChats.setMuted(recent, muted)
    }),
    onHideChat: (chat) => {
      const recent = recentOf(chat)
      if (recent) recentChats.hide(recent)
    },
  }
  const notice = workspacesState.status === 'failed' ? `Couldn’t load workspaces: ${workspacesState.message}` : sidebarProblem

  // The user's own menu has the settings, which are only stayed in when already there.
  const openSettingsPage = () => {
    leaveSidebar()
    if (!inSettings) void navigate({ to: '/settings', state: { settingsOpenedHere: true } })
  }
  // The settings' own sidebar leaves them again: back to where they were opened from, or home
  // when they were come to some other way.
  const toggleSettings = () => {
    leaveSidebar()
    if (!inSettings) return void navigate({ to: '/settings', state: { settingsOpenedHere: true } })
    if (router.state.location.state.settingsOpenedHere) return router.history.back()
    void navigate({ to: '/' })
  }
  // Beside the settings, their parts take the sidebar's place. Not on a narrow screen, where the
  // sidebar is beneath the page and the parts are the page itself.
  const settingsSidebar = (collapsed: boolean) => (
    <SettingsSidebar
      groups={settingsNavGroups((section) => router.buildLocation({ to: '/settings', search: { section } }).href, admin)}
      current={settingsPage?.search.section ?? FIRST_SECTION}
      // In place, so that going back leaves the settings rather than going through their parts.
      onSelect={(section) => {
        // The ids are the parts' own, which the block knows only as strings.
        if (!isSettingsSection(section)) return
        void navigate({ to: '/settings', search: { section }, replace: true, state: true })
      }}
      onClose={toggleSettings}
      collapsed={collapsed}
      onSignOut={signOut}
    />
  )
  const sidebar = (collapsed: boolean) => (
    <Sidebar
      user={{ name: user.name, avatarUrl }}
      pinned={pinnedWorkspaces}
      onReorderPinned={(order) => keepStarredOrder(preferences, order)}
      workspaces={workspaces}
      // The chat open is marked where it is listed, and its workspace only on the rail, or where it is not.
      selectedWorkspaceId={collapsed || selectedChatId === undefined || !sidebarChats.some(({ id }) => id === selectedChatId) ? workspaceId : undefined}
      // Each puts the sidebar away on a narrow screen, even where it goes to the page it is over.
      onSelectWorkspace={openWorkspace}
      chats={sidebarChats}
      selectedChatId={selectedChatId}
      onSelectChat={openChat}
      actions={sidebarActions}
      onGoHome={() => {
        leaveSidebar()
        void navigate({ to: '/' })
      }}
      logoUrl={siteLogoUrl(config)}
      announcement={config?.announcement?.trim() || undefined}
      notice={notice}
      empty={workspacesState.status === 'ready' && workspaces.length === 0
        ? {
            href: router.buildLocation({ to: '/' }).href,
            current: homePage !== undefined,
            onNewWorkspace: () => {
              leaveSidebar()
              void navigate({ to: '/' })
            },
          }
        : undefined}
      connections={connectionLogos}
      library={{
        current: [libraryPage, libraryItemPage, templatesPage, templatePage].some((match) => match !== undefined),
        waiting: totalGadgetAsks(summaries),
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/library' })
        },
      }}
      workspacesPage={{
        current: workspacesPage !== undefined,
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/workspaces' })
        },
      }}
      automationsPage={{
        current: automationsPage !== undefined,
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/automations' })
        },
      }}
      apps={gatekeeperApps.map(({ id, title, icon }) => ({
        id,
        title,
        iconUrl: icon?.url,
        current: gatekeeperAppPage?.params.appId === id,
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/apps/$appId', params: { appId: id } })
        },
      }))}
      connectionsPage={{
        current: connectionsPage !== undefined,
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/connections' })
        },
      }}
      settingsPage={{ current: inSettings, onOpen: openSettingsPage }}
      onSignOut={signOut}
      onSearch={() => {
        leaveSidebar()
        setSearching(true)
      }}
      collapsed={collapsed}
    />
  )
  // A task's notification shows while the connection has nothing to say, and one for the chat
  // on screen does not show at all.
  const { notice: taskNotice, dismiss: dismissNotice } = useTaskNotices((inWorkspace, inChat) =>
    chatPage?.params.workspaceId === inWorkspace && chatPage.params.chatId === inChat)
  const island: ConnectionIslandState | undefined = connectionState.status !== 'hidden'
    ? connectionState
    : taskNotice && {
        status: 'notified',
        kind: taskNotice.kind === 'taskCompleted' ? 'finished' : 'approval',
        title: taskNotice.chatTitle,
        onOpen: () => {
          dismissNotice(taskNotice.id)
          leaveSidebar()
          void navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: taskNotice.workspaceId, chatId: taskNotice.chatId }, state: { chatTitle: taskNotice.chatTitle } })
        },
      }
  const status = (
    <ConnectionIsland
      state={island}
      onDismiss={connectionState.status !== 'hidden' || !taskNotice ? connection.dismiss : () => dismissNotice(taskNotice.id)}
    />
  )
  // A browser notification clicked opens its chat in the tab last used.
  useBrowserPushSync((path) => void router.navigate({ href: path }))
  // Had back from the edge: what was last shown beside the page, or what was made last. Before
  // the library has been read, the pane opens empty until it has.
  const openAside = besideRef && besideKey && !named && !openedEmpty
    ? () => {
        const open = lastShown(preferences.getSnapshot(), besideRef.workspaceId, besideRef.chatId) ?? items[0]?.key
        if (open !== undefined) return aside.show(open, besideRef)
        writeLayoutPrefs({ asideOpen: true })
        setOpenedEmptyAt(besideKey)
      }
    : undefined
  const closeAside = besideOf && named ? aside.hide : openedEmpty ? hideEmpty : undefined

  // What opening a workspace asks that no pane of its asks is the page, beside the sidebar, which
  // stays to go elsewhere by: in the item's place on its own page, else the page's. What it is in
  // place of stays under it, out of sight, so that what waits on the answer is there to have it,
  // in the same element either way, so that it is not made again as it is hidden and shown.
  const accessQuestion = usePageAccessQuestion()
  const asked = (content: ReactNode, here: boolean) => {
    const covered = here && accessQuestion !== null
    return (
      <>
        <div inert={covered} className={covered ? 'hidden' : 'contents'}>{content}</div>
        {covered && accessQuestion}
      </>
    )
  }

  // What search can do where the user is, in a workspace's chat or on its page: a new chat in the
  // workspace as the page's own button starts one, keeping what is shown beside it, and inviting
  // people, which the page's own dialog is asked for (`?invite`).
  const searchWorkspaceId = chatPage?.params.workspaceId ?? workspacePage?.params.workspaceId
  const searchNewChat = () => {
    if (searchWorkspaceId !== undefined) void navigate({ to: '/', search: { workspace: searchWorkspaceId, open: carriedOpen(besideOf?.open) } })
  }
  const searchContext: SearchContext | undefined = searchWorkspaceId === undefined
    ? undefined
    : chatPage
      ? { kind: 'chat', workspaceId: searchWorkspaceId, onNewChat: searchNewChat }
      : {
          kind: 'workspace',
          workspaceId: searchWorkspaceId,
          onNewChat: searchNewChat,
          onInvite: () => void router.navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, invite: true as const }) }),
        }

  // Over the page, whichever shell it is in, and reached by ⌘K from either.
  const search = <AppSearch
      open={searching}
      onOpenChange={setSearching}
      connections={connectionsState.status === 'ready' ? connectionsState.connections : []}
      context={searchContext}
    />

  if (narrow) {
    return (
      <>
      <NarrowShell
        sidebar={{
          content: sidebar(false),
          open: sidebarOpen,
          onOpenChange: (open) => setSidebarAt(open ? router.state.location.pathname : undefined),
          // On the pages the sidebar goes to. Those further in have their way up already, such as
          // a chat's workspace crumb, or an item's own back button.
          // The settings' list of parts is one of them; a part has its way back to the list.
          button: [homePage, workspacePage, libraryPage, workspacesPage, automationsPage, gatekeeperAppPage, connectionsPage, settingsPage?.search.section === undefined ? settingsPage : undefined].some((match) => match !== undefined),
        }}
        status={status}
        aside={pageItem ? undefined : asideElement}
        // Beside a chat only: over a workspace's page, the strip tapped at the edge would be over
        // the ends of its rows, which open what they list.
        onOpenAside={chatRef ? openAside : undefined}
      >
        {asked(pageItem ? asideElement : <Outlet />, true)}
      </NarrowShell>
      {search}
      </>
    )
  }

  return (
    <>
    <AppShell
      sidebar={inSettings ? settingsSidebar : sidebar}
      status={status}
      initialSidebar={prefs.sidebar}
      onSidebarChange={(size) => writeLayoutPrefs({ sidebar: size })}
      initialAsideShare={prefs.asideShare}
      onAsideShareChange={(asideShare) => writeLayoutPrefs({ asideShare })}
      aside={asideElement === null ? null : asked(asideElement, pageItem !== undefined)}
      asideAlone={pageItem !== undefined || expanded}
      asideFullScreen={fullScreen}
      onOpenAside={openAside}
      onCloseAside={closeAside}
      onExpandAside={expandAside}
    >
      {asked(<Outlet />, pageItem === undefined)}
    </AppShell>
    {search}
    </>
  )
}
