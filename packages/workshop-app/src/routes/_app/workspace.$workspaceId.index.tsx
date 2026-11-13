import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import { asideFor } from '@/aside/useAsideNavigation'
import { WORKSPACE_TABS, WorkspacePane, type WorkspaceTab } from '@/workspaces/WorkspacePane'

const validateTab = (value: unknown): WorkspaceTab | undefined =>
  WORKSPACE_TABS.find((tab) => tab.value === value && value !== 'chats')?.value

/** One workspace: its chats, or with `?tab=`, what it has made or who has access to it. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: WorkspaceTab } => ({ tab: validateTab(search.tab) }),
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const { tab = 'chats' } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <WorkspacePane
      // Keyed, so each workspace loads its own chats rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      tab={tab}
      // In place, so that going back leaves the workspace rather than going through its tabs.
      onTabChange={(next) =>
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: next === 'chats' ? undefined : next }, replace: true })
      }
      onOpenChat={({ id, title }) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId',
          params: { workspaceId, chatId: id },
          search: { open: asideFor({ workspaceId, chatId: id }) },
          state: { chatTitle: title },
        })
      }
      chatHref={(id) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }).href}
      onOpenItem={(item) => navigate(pageOf(workspaceId, item))}
      itemHref={(item) => router.buildLocation(pageOf(workspaceId, item)).href}
      onNewChat={() => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId } })}
    />
  )
}
