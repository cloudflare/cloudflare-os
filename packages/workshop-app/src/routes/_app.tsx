import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { AsideContext, useAsideState } from '@/aside/AsideContext'
import { AsidePane } from '@/aside/AsidePane'
import { Sidebar } from '@/blocks/Sidebar'
import { AppShell } from '@/layouts/AppShell'
import { useApi } from '@/rpc/ApiContext'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'
import { latestChat } from '@/workspaces/latestChat'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
import { formatActivity } from '@/workspaces/formatActivity'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

/** Everything under here needs the backend; routes outside it (the gallery) work without one. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <RpcGate connection={sharedConnection()}>
      <WorkspacesProvider>
        <AppFrame />
      </WorkspacesProvider>
    </RpcGate>
  ),
})

// Placeholder logos until real connected apps are wired in.
const placeholderLogos = [0, 1, 2].map((i) => <span key={i} className="size-5 rounded-full bg-kumo-fill" />)

const AppFrame = () => {
  const { api, user } = useApi()
  const workspacesState = useWorkspaces()
  const navigate = useNavigate()
  const { workspaceId } = useParams({ strict: false })
  // What pages opened beside themselves. It stays open from one page to the next.
  const aside = useAsideState()

  // Each workspace is listed by its title and when it was last active.
  const workspaces =
    workspacesState.status === 'ready'
      ? workspacesState.workspaces.map(({ id, title, lastActive }) => ({
          id,
          title,
          workspaceLabel: workspaceLabel(title),
          subtitle: formatActivity(lastActive),
        }))
      : []
  const notice =
    workspacesState.status === 'failed'
      ? `Couldn’t load workspaces: ${workspacesState.message}`
      : workspacesState.status === 'ready' && workspaces.length === 0
        ? 'No workspaces yet.'
        : undefined

  // A workspace with no chats yet, or that could not be read, opens on its own page.
  const openLatestChat = async (id: string) => {
    const chat = await latestChat(() => api.openWorkspace(id)).catch(() => undefined)
    if (chat) navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId: id, chatId: chat.id }, state: { chatTitle: chat.title } })
    else navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id } })
  }

  return (
    <AsideContext value={aside.actions}>
      <AppShell
        sidebar={(collapsed) => (
          <Sidebar
            user={{ name: user.name }}
            workspaces={workspaces}
            selectedWorkspaceId={workspaceId}
            onSelectWorkspace={(id) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id } })}
            notice={notice}
            connections={placeholderLogos}
            library={{ shown: aside.shown, onToggle: aside.actions.toggle }}
            collapsed={collapsed}
          />
        )}
        aside={aside.shown && (
          <AsidePane tabs={aside.tabs} fullScreen={aside.fullScreen} actions={aside.actions} onOpenLatestChat={(id) => void openLatestChat(id)} />
        )}
        asideFullScreen={aside.fullScreen}
        onOpenAside={aside.actions.show}
        onCloseAside={aside.actions.hide}
      >
        <Outlet />
      </AppShell>
    </AsideContext>
  )
}
