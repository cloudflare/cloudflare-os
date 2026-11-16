import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import { asideFor } from '@/aside/useAsideNavigation'
import type { LibraryEntry } from '@/library/libraryEntries'
import { WORKSPACE_TABS, WorkspacePane, type WorkspaceTab } from '@/workspaces/WorkspacePane'
import { useAutomationLink } from '../-automationLink'
import { useConnectionLinks } from '../-connectionLinks'

// A file is shown from the chat it was sent in, which has its bytes.
const page = (entry: LibraryEntry) => ({ ...pageOf(entry.workspaceId, entry.item), search: { chat: entry.chatId } })

const validateTab = (value: unknown): WorkspaceTab | undefined =>
  WORKSPACE_TABS.find((tab) => tab.value === value && value !== 'chats')?.value

const validateConnection = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)

/**
 * One workspace: its chats, or with `?tab=`, what it has made, what it can reach, what runs by
 * itself, who has access to it, or its settings. `?connection=` opens one of what it can reach.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: WorkspaceTab; connection?: number } => {
    const tab = validateTab(search.tab)
    return tab === 'connections' ? { tab, connection: validateConnection(search.connection) } : { tab }
  },
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const { tab = 'chats', connection } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const automationLink = useAutomationLink()
  const connectionLinks = useConnectionLinks()
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
      onOpenEntry={(entry) => navigate(page(entry))}
      entryHref={(entry) => router.buildLocation(page(entry)).href}
      automationLink={automationLink}
      onNewChat={() => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId } })}
      // As the Library page's New starts one on the home page, here in this workspace.
      onNew={(format) => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId }, search: { format: format?.id } })}
      onDeleted={() => navigate({ to: '/', replace: true })}
      link={new URL(router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href, window.location.origin).href}
      openConnection={connection}
      // In place, as its tab is: closing it is not a page to go back through.
      onConnectionChange={(next) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'connections', connection: next }, replace: true })}
      connectionLinks={connectionLinks}
    />
  )
}
