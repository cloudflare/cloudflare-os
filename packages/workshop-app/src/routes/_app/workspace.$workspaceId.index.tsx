import { createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { carriedOpen, validateAsideParam } from '@/aside/asideItems'
import { asideFor, carryAside, useAsideNavigation } from '@/aside/useAsideNavigation'
import { WORKSPACE_TABS, WorkspacePane, type WorkspaceTab } from '@/workspaces/WorkspacePane'

const validateTab = (value: unknown): WorkspaceTab | undefined =>
  WORKSPACE_TABS.find((tab) => tab.value === value && value !== 'chats')?.value

// A chat, as the old app's address names one (`?chat=`), which a notification still sends.
const validateChat = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * One workspace: its chats, or with `?tab=`, what it has made, what runs in it by itself or who has
 * access to it, and what is shown beside it (`?open=`, see `asideItems`), which the frame lays out
 * (`_app`). With the old app's `?chat=`, which a notification opens, it is that chat's own page.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: WorkspaceTab; open?: string; chat?: number } => ({
    tab: validateTab(search.tab),
    open: validateAsideParam(search.open),
    chat: validateChat(search.chat),
  }),
  beforeLoad: ({ params: { workspaceId }, search: { chat } }) => {
    if (chat !== undefined) throw redirect({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: chat }, replace: true })
  },
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const { tab = 'chats', open } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  return (
    <WorkspacePane
      // Keyed, so each workspace loads its own chats rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      tab={tab}
      // In place, so that going back leaves the workspace rather than going through its tabs.
      onTabChange={(next) =>
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: next === 'chats' ? undefined : next, open }, replace: true })
      }
      // What is shown beside the workspace stays beside the chat, so that it is there from one
      // chat to the next; otherwise the chat has what was last shown beside it.
      onOpenChat={({ id, title }) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId',
          params: { workspaceId, chatId: id },
          search: { open: carryAside(open, { workspaceId, chatId: id }) ?? asideFor({ workspaceId, chatId: id }) },
          state: { chatTitle: title },
        })
      }
      chatHref={(id) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }).href}
      onOpenItem={(item) => aside.show(item.key, { workspaceId })}
      itemHref={(item) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library', open: item.key } }).href}
      onNewChat={() => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId }, search: { open: carriedOpen(open) } })}
      // Its own address, whole, as it is copied to be opened elsewhere.
      link={new URL(router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href, window.location.origin).href}
      // Deleted, or out of the viewer's list, it is left for home, as there is nothing here to go back to.
      onRemoved={() => navigate({ to: '/' })}
    />
  )
}
