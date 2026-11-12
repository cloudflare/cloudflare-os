import { useEffect, useState, type ReactNode } from 'react'
import { createFileRoute, Outlet, useLocation, useMatch, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { asideItemFor, formatAsideRef, pageOf, parseAsideRef, parseItemPageId, type AsideItem } from '@/aside/asideItems'
import { AsidePane, EmptyAsidePane } from '@/aside/AsidePane'
import { lastShown } from '@/aside/lastShown'
import { useAsideNavigation } from '@/aside/useAsideNavigation'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { Sidebar } from '@/blocks/Sidebar'
import { ChatSessionsProvider } from '@/chat/ChatSessionsProvider'
import { AppShell } from '@/layouts/AppShell'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { useApi } from '@/rpc/ApiContext'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
import { formatActivity } from '@/workspaces/formatActivity'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

/** Everything under here needs the backend; routes outside it (the gallery) work without one. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <RpcGate connection={sharedConnection()}>
      <WorkspacesProvider>
        <ChatSessionsProvider>
          <AppFrame />
        </ChatSessionsProvider>
      </WorkspacesProvider>
    </RpcGate>
  ),
})

// Placeholder logos until real connected apps are wired in.
const placeholderLogos = [0, 1, 2].map((i) => <span key={i} className="size-5 rounded-full bg-kumo-fill" />)

const absolute = (href: string) => new URL(href, window.location.origin).href

/**
 * The frame, laid out for the page the URL names (see `AppShell`): beside a chat, what it names
 * there (`?open=`); as an item's own page (an app's, or one in the library), the item alone. Both are the same card, so going from
 * one to the other keeps what is in it running.
 */
const AppFrame = () => {
  const { user } = useApi()
  const workspacesState = useWorkspaces()
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  const { workspaceId } = useParams({ strict: false })
  const [prefs] = useState(readLayoutPrefs)

  const chatPage = useMatch({ from: '/_app/workspace/$workspaceId/chat/$chatId', shouldThrow: false })
  const newChatPage = useMatch({ from: '/_app/workspace/$workspaceId/new', shouldThrow: false })
  const appPage = useMatch({ from: '/_app/app/$itemId', shouldThrow: false })
  const libraryItemPage = useMatch({ from: '/_app/library/$itemId', shouldThrow: false })
  const libraryPage = useMatch({ from: '/_app/library/', shouldThrow: false })
  const itemPage = appPage ?? libraryItemPage
  const pageItem = itemPage && parseItemPageId(itemPage.params.itemId)

  // Beside a chat, or a chat that is still to be made: what it has to show, and which is named.
  const besideOf = chatPage ?? newChatPage
  const chatId = chatPage?.params.chatId
  const chatRef = chatPage && { workspaceId: chatPage.params.workspaceId, chatId: chatPage.params.chatId }
  // The chat what is shown comes from: the one the page is, or the one an item's own page names,
  // which says what the item is (a file's name and type) and where its bytes are.
  const pageChatId = itemPage?.search.chat
  const shownFrom = chatRef ?? (pageItem && pageChatId !== undefined ? { workspaceId: pageItem.workspaceId, chatId: pageChatId } : undefined)
  const named = besideOf && parseAsideRef(besideOf.search.open)
  // The aside, had back beside a chat that has shown nothing of what it has: open with nothing in
  // it while the rest of the chat is read, until something turns up. Kept for that chat alone.
  const chatKey = chatRef && `${chatRef.workspaceId}/${chatRef.chatId}`
  const [openedEmptyAt, setOpenedEmptyAt] = useState<string>()
  if (openedEmptyAt !== undefined && (named || openedEmptyAt !== chatKey)) setOpenedEmptyAt(undefined)
  const openedEmpty = chatRef !== undefined && !named && openedEmptyAt === chatKey
  const library = useChatLibrary(shownFrom, openedEmpty)
  const { items } = library

  // The first thing found is the latest the chat has, as what was read is older than what was there.
  const firstFound = openedEmpty ? items[0]?.key : undefined
  const chatWorkspaceId = chatPage?.params.workspaceId
  useEffect(() => {
    if (firstFound !== undefined && chatWorkspaceId !== undefined && chatId !== undefined) aside.show(firstFound, { workspaceId: chatWorkspaceId, chatId })
  }, [firstFound, chatWorkspaceId, chatId, aside])
  const hideEmpty = () => {
    writeLayoutPrefs({ asideOpen: false })
    setOpenedEmptyAt(undefined)
  }

  // Full screen belongs to the page it was asked for on, so it is left behind with it.
  const [fullScreenAt, setFullScreenAt] = useState<string>()
  const [setFullScreen] = useState(() => (on: boolean) => setFullScreenAt(on ? router.state.location.pathname : undefined))
  const pathname = useLocation({ select: (location) => location.pathname })
  const fullScreen = pageItem !== undefined && fullScreenAt === pathname

  // Its own page, shown with the changes proposed in the chat it is shown from.
  const linkTo = (inWorkspace: string, item: AsideItem, fromChat: number | undefined) =>
    absolute(router.buildLocation({ ...pageOf(inWorkspace, item), search: { chat: fromChat } }).href)

  let asideElement: ReactNode = null
  if (itemPage && pageItem) {
    const { workspaceId: pageWorkspaceId, ref } = pageItem
    const { chat: fromChat } = itemPage.search
    const item = asideItemFor(pageWorkspaceId, ref, fromChat, items)
    const open = formatAsideRef(ref)
    const expandedHere = router.state.location.state.fromChat === true
    asideElement = (
      <AsidePane
        placement="page"
        item={item}
        link={linkTo(pageWorkspaceId, item, fromChat)}
        fullScreen={fullScreen}
        onFullScreenChange={setFullScreen}
        // Expanded from beside a page, it goes back there; opened with a chat named, beside that.
        // Opened otherwise, such as from the library, there is nothing to collapse into.
        onCollapse={expandedHere
          ? () => router.history.back()
          : fromChat !== undefined
            ? () => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId: pageWorkspaceId, chatId: fromChat }, search: { open } })
            : undefined}
      />
    )
  } else if (besideOf && named) {
    const item = asideItemFor(besideOf.params.workspaceId, named, chatId, items)
    const { workspaceId: besideWorkspaceId } = besideOf.params
    asideElement = (
      <AsidePane
        placement="beside"
        item={item}
        items={items}
        link={linkTo(besideWorkspaceId, item, chatId)}
        onFullScreenChange={setFullScreen}
        onSelect={(key) => aside.show(key, chatRef)}
        onHide={aside.hide}
        onExpand={() => navigate({ ...pageOf(besideWorkspaceId, item), search: { chat: chatId }, state: { fromChat: true } })}
      />
    )
  } else if (openedEmpty) {
    asideElement = <EmptyAsidePane reading={library.reading} problem={library.problem} onRetry={library.retry} onHide={hideEmpty} />
  }

  // Each workspace is listed by its title and when it was last active.
  const workspaces =
    workspacesState.status === 'ready'
      ? workspacesState.workspaces.map(({ id, title, lastActive }) => ({
          id,
          title,
          workspaceLabel: workspaceLabel(title),
          subtitle: formatActivity(lastActive),
          href: router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId: id } }).href,
        }))
      : []
  const notice =
    workspacesState.status === 'failed'
      ? `Couldn’t load workspaces: ${workspacesState.message}`
      : workspacesState.status === 'ready' && workspaces.length === 0
        ? 'No workspaces yet.'
        : undefined

  return (
    <AppShell
      sidebar={(collapsed) => (
        <Sidebar
          user={{ name: user.name }}
          workspaces={workspaces}
          selectedWorkspaceId={workspaceId}
          onSelectWorkspace={(id) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id } })}
          onGoHome={() => navigate({ to: '/' })}
          notice={notice}
          connections={placeholderLogos}
          library={{ current: libraryPage !== undefined || libraryItemPage !== undefined, onOpen: () => navigate({ to: '/library' }) }}
          collapsed={collapsed}
        />
      )}
      initialSidebar={prefs.sidebar}
      onSidebarChange={(sidebar) => writeLayoutPrefs({ sidebar })}
      initialAsideShare={prefs.asideShare}
      onAsideShareChange={(asideShare) => writeLayoutPrefs({ asideShare })}
      aside={asideElement}
      asideAlone={pageItem !== undefined}
      asideFullScreen={fullScreen}
      // Had back from the edge: what was last shown beside the chat, or what it made last. Before
      // anything it has is known, the pane opens empty, and the chat is read for it.
      onOpenAside={chatRef && chatKey && !named && !openedEmpty
        ? () => {
            const open = lastShown(chatRef.workspaceId, chatRef.chatId) ?? items[0]?.key
            if (open !== undefined) return aside.show(open, chatRef)
            writeLayoutPrefs({ asideOpen: true })
            setOpenedEmptyAt(chatKey)
          }
        : undefined}
      onCloseAside={besideOf && named ? aside.hide : openedEmpty ? hideEmpty : undefined}
    >
      <Outlet />
    </AppShell>
  )
}
