import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createFileRoute, Outlet, useLocation, useMatch, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { asideItemFor, formatAsideRef, itemPageId, pageOf, parseAsideRef, parseItemPageId, type AsideItem, type AsideOutput } from '@/aside/asideItems'
import { AsidePane, EmptyAsidePane } from '@/aside/AsidePane'
import { lastShown, rememberShown } from '@/aside/lastShown'
import { carryAside, useAsideNavigation, type BesideRef } from '@/aside/useAsideNavigation'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { useAgentsWaiting } from '@/automations/AgentsWaitingContext'
import { AgentsWaitingProvider } from '@/automations/AgentsWaitingProvider'
import { ConnectionIsland, type ConnectionIslandState } from '@/blocks/ConnectionIsland'
import { SettingsSidebar } from '@/blocks/SettingsSidebar'
import { Sidebar } from '@/blocks/Sidebar'
import { ChatSessionsProvider } from '@/chat/ChatSessionsProvider'
import { useWaitingAsks, WaitingAsksProvider } from '@/gadgets/WaitingAsksProvider'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
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
import { useServerConfig } from '@/rpc/serverConfig'
import { sharedConnection } from '@/rpc/sharedConnection'
import { useIsAdmin } from '@/settings/admin/useIsAdmin'
import { SiteFrame } from '@/rpc/SiteFrame'
import { siteLogoUrl } from '@/rpc/siteLook'
import { OnboardingGate } from '@/settings/OnboardingGate'
import { FIRST_SECTION, isSettingsSection, settingsNavGroups } from '@/settings/settingsSections'
import { useOwnAvatar } from '@/settings/useOwnAvatar'
import { ShareLinkGate } from '@/workspaces/ShareLinkGate'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
import { formatActivity } from '@/workspaces/formatActivity'
import { useLiveWorkspace } from '@/workspaces/useLiveWorkspace'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { AppSearch } from './-AppSearch'

/** Everything under here needs the backend; routes outside it (the gallery) work without one. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <SiteFrame>
      <RpcGate connection={sharedConnection()}>
        <FeatureFlagsProvider>
          {/* A new user is set up before anything else is read for them. */}
          <OnboardingGate>
            {/* Before the workspaces are listed, so that one a link let the user in to is among them. */}
            <ShareLinkGate>
              <WorkspacesProvider>
                <UnreadProvider>
                  <AgentsWaitingProvider>
                    <ChatSessionsProvider>
                      <WaitingAsksProvider>
                        <AppFrame />
                      </WaitingAsksProvider>
                    </ChatSessionsProvider>
                  </AgentsWaitingProvider>
                </UnreadProvider>
              </WorkspacesProvider>
            </ShareLinkGate>
          </OnboardingGate>
        </FeatureFlagsProvider>
      </RpcGate>
    </SiteFrame>
  ),
})

// Placeholder logos until real connected apps are wired in.
const placeholderLogos = [0, 1, 2].map((i) => <span key={i} className="size-5 rounded-full bg-kumo-fill" />)

/** What a workspace's agents' runs waiting on the user say of it in the sidebar, where any do. */
const agentsWaitingWords = (count: number) =>
  count === 0 ? undefined : count === 1 ? 'An agent needs you' : `${count} agent runs need you`

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
  const waiting = useAgentsWaiting()
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  const { workspaceId } = useParams({ strict: false })
  const [prefs] = useState(readLayoutPrefs)
  const narrow = useNarrowScreen()
  // Whether the deployment's own settings are listed after the user's.
  const admin = useIsAdmin()
  const asks = useWaitingAsks()

  const homePage = useMatch({ from: '/_app/', shouldThrow: false })
  const workspacePage = useMatch({ from: '/_app/workspace/$workspaceId/', shouldThrow: false })
  const chatPage = useMatch({ from: '/_app/workspace/$workspaceId/chat/$chatId', shouldThrow: false })
  const newChatPage = useMatch({ from: '/_app/workspace/$workspaceId/new', shouldThrow: false })
  const appPage = useMatch({ from: '/_app/app/$itemId', shouldThrow: false })
  const libraryItemPage = useMatch({ from: '/_app/library/$itemId', shouldThrow: false })
  const libraryPage = useMatch({ from: '/_app/library/', shouldThrow: false })
  // The templates are come to from the library, and are part of it.
  const templatesPage = useMatch({ from: '/_app/library/templates/', shouldThrow: false })
  const templatePage = useMatch({ from: '/_app/library/templates/$templateId', shouldThrow: false })
  const workspacesPage = useMatch({ from: '/_app/workspaces', shouldThrow: false })
  const connectionsPage = useMatch({ from: '/_app/connections', shouldThrow: false })
  const settingsPage = useMatch({ from: '/_app/settings', shouldThrow: false })
  // A skill's page is part of the settings, where the skills are listed.
  const skillPage = useMatch({ from: '/_app/skills/$skillId', shouldThrow: false })
  const inSettings = settingsPage !== undefined || skillPage !== undefined
  const itemPage = appPage ?? libraryItemPage
  const pageItem = itemPage && parseItemPageId(itemPage.params.itemId)
  // The workspace that is open, whose title and the viewer's role in it are kept live.
  useLiveWorkspace(workspaceId ?? pageItem?.workspaceId)

  // Beside a chat, a chat that is still to be made, or a workspace's own page: which is named.
  const besideOf = chatPage ?? newChatPage ?? workspacePage
  const chatId = chatPage?.params.chatId
  const chatRef = chatPage && { workspaceId: chatPage.params.workspaceId, chatId: chatPage.params.chatId }
  // The page that has its workspace's library to show beside it: a chat, or the workspace's own,
  // where what was made is shown as it stands, with no chat's changes.
  const besideRef: BesideRef | undefined = chatRef ?? (workspacePage && { workspaceId: workspacePage.params.workspaceId })
  // Where what is shown comes from: the page it is beside, or the chat an item's own page names,
  // which says what the item is (a file's name and type) and where its bytes are.
  const pageChatId = itemPage?.search.chat
  const shownFrom = besideRef ?? (pageItem && pageChatId !== undefined ? { workspaceId: pageItem.workspaceId, chatId: pageChatId } : undefined)
  const named = besideOf && parseAsideRef(besideOf.search.open)
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

  // Full screen belongs to the page it was asked for on, so it is left behind with it.
  const [fullScreenAt, setFullScreenAt] = useState<string>()
  const [setFullScreen] = useState(() => (on: boolean) => setFullScreenAt(on ? router.state.location.pathname : undefined))
  const pathname = useLocation({ select: (location) => location.pathname })
  // A narrow screen is filled already.
  const fullScreen = !narrow && pageItem !== undefined && fullScreenAt === pathname
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

  // Its own page, shown with the changes proposed in the chat it is shown from.
  const linkTo = (inWorkspace: string, item: AsideItem, fromChat: number | undefined) =>
    absolute(router.buildLocation({ ...pageOf(inWorkspace, item), search: { chat: fromChat } }).href)

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
  if (itemPage && pageItem) {
    const { workspaceId: pageWorkspaceId, ref } = pageItem
    const { chat: fromChat } = itemPage.search
    const item = asideItemFor(pageWorkspaceId, ref, fromChat, known)
    const open = formatAsideRef(ref)
    const expandedHere = router.state.location.state.fromChat === true
    // Collapse goes back beside the chat it came from, so no other chat is offered.
    const backToChat = !narrow && (expandedHere || fromChat !== undefined)
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
        // Expanded from beside a page, it goes back there; opened with a chat named, beside that.
        // Opened otherwise, such as from the library, there is nothing to collapse into. On a
        // narrow screen, where it is beside nothing, it goes up.
        onCollapse={narrow ? up : expandedHere
          ? () => router.history.back()
          : fromChat !== undefined
            ? () => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: pageWorkspaceId, chatId: fromChat }, search: { open } })
            : undefined}
        // It stays beside the workspace's page, as it would going there from a chat.
        onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: pageWorkspaceId }, search: { open: carryAside(open, { workspaceId: pageWorkspaceId }) } })}
        onOpenChat={backToChat ? undefined : (toChat) => {
          rememberShown(pageWorkspaceId, toChat.id, open)
          void navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: pageWorkspaceId, chatId: toChat.id }, search: { open }, state: { chatTitle: toChat.title } })
        }}
        onNewChat={backToChat ? undefined : (gadgetTitle) =>
          navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId: pageWorkspaceId }, search: { open }, state: { gadgetTitle } })}
      />
    )
  } else if (besideOf && named) {
    const item = asideItemFor(besideOf.params.workspaceId, named, chatId, known)
    const { workspaceId: besideWorkspaceId } = besideOf.params
    asideElement = (
      <AsidePane
        placement="beside"
        item={item}
        items={items}
        link={linkTo(besideWorkspaceId, item, chatId)}
        onFullScreenChange={setFullScreen}
        narrow={narrow}
        onOpenSettings={builds(besideWorkspaceId) ? openSettings : undefined}
        onUpdateProposed={openUpdate}
        onDeleted={aside.hide}
        onSelect={(key) => aside.show(key, besideRef)}
        onHide={aside.hide}
        onExpand={() => navigate({ ...pageOf(besideWorkspaceId, item), search: { chat: chatId }, state: { fromChat: true } })}
      />
    )
  } else if (openedEmpty) {
    asideElement = <EmptyAsidePane reading={library.reading} problem={library.problem} onRetry={library.retry} onHide={hideEmpty} narrow={narrow} />
  }

  // Each workspace is listed by its title and when it was last active, or what waits on the user
  // in it, and marked while it has anything unread.
  const workspaces =
    workspacesState.status === 'ready'
      ? workspacesState.workspaces.map(({ id, title, lastActive }) => ({
          id,
          title,
          workspaceLabel: workspaceLabel(title),
          workspaceLook: looks[id],
          subtitle: formatActivity(lastActive),
          attention: agentsWaitingWords(waiting.get(id) ?? 0),
          unread: unread?.totals.workspaces.has(id),
          href: router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId: id } }).href,
        }))
      : []
  const notice =
    workspacesState.status === 'failed'
      ? `Couldn’t load workspaces: ${workspacesState.message}`
      : workspacesState.status === 'ready' && workspaces.length === 0
        ? 'No workspaces yet.'
        : undefined

  // The user's own button opens the settings, and leaves them again: back to where they were
  // opened from, or home when they were come to some other way.
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
      current={skillPage ? 'skills' : (settingsPage?.search.section ?? FIRST_SECTION)}
      // In place, so that going back leaves the settings rather than going through their parts.
      // Not from a skill's page, which is somewhere to go back to.
      onSelect={(section) => {
        // The ids are the parts' own, which the block knows only as strings.
        if (!isSettingsSection(section)) return
        void navigate({ to: '/settings', search: { section }, ...(skillPage ? {} : { replace: true, state: true }) })
      }}
      onClose={toggleSettings}
      collapsed={collapsed}
      onSignOut={signOut}
    />
  )
  const sidebar = (collapsed: boolean) => (
    <Sidebar
      user={{ name: user.name, avatarUrl }}
      workspaces={workspaces}
      selectedWorkspaceId={workspaceId}
      // Each puts the sidebar away on a narrow screen, even where it goes to the page it is over.
      onSelectWorkspace={(id) => {
        leaveSidebar()
        // What is shown beside one of the workspace's pages stays beside its own.
        const open = besideOf?.params.workspaceId === id ? carryAside(besideOf.search.open, { workspaceId: id }) : undefined
        void navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id }, search: { open } })
      }}
      onGoHome={() => {
        leaveSidebar()
        void navigate({ to: '/' })
      }}
      logoUrl={siteLogoUrl(config)}
      announcement={config?.announcement?.trim() || undefined}
      notice={notice}
      connections={placeholderLogos}
      library={{
        current: [libraryPage, libraryItemPage, templatesPage, templatePage].some((match) => match !== undefined),
        waiting: asks.total,
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
      connectionsPage={{
        current: connectionsPage !== undefined,
        onOpen: () => {
          leaveSidebar()
          void navigate({ to: '/connections' })
        },
      }}
      settingsPage={{ current: inSettings, onOpen: toggleSettings }}
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
        const open = lastShown(besideRef.workspaceId, besideRef.chatId) ?? items[0]?.key
        if (open !== undefined) return aside.show(open, besideRef)
        writeLayoutPrefs({ asideOpen: true })
        setOpenedEmptyAt(besideKey)
      }
    : undefined
  const closeAside = besideOf && named ? aside.hide : openedEmpty ? hideEmpty : undefined

  // Over the page, whichever shell it is in, and reached by ⌘K from either.
  const search = <AppSearch open={searching} onOpenChange={setSearching} />

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
          button: [homePage, workspacePage, libraryPage, workspacesPage, connectionsPage, settingsPage?.search.section === undefined ? settingsPage : undefined].some((match) => match !== undefined),
        }}
        status={status}
        aside={pageItem ? undefined : asideElement}
        // Beside a chat only: over a workspace's page, the strip tapped at the edge would be over
        // the ends of its rows, which open what they list.
        onOpenAside={chatRef ? openAside : undefined}
      >
        {pageItem ? asideElement : <Outlet />}
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
      aside={asideElement}
      asideAlone={pageItem !== undefined}
      asideFullScreen={fullScreen}
      onOpenAside={openAside}
      onCloseAside={closeAside}
    >
      <Outlet />
    </AppShell>
    {search}
    </>
  )
}
