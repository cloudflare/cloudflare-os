import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { Sidebar } from '@/blocks/Sidebar'
import { AppShell } from '@/layouts/AppShell'
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
        <AppFrame />
      </WorkspacesProvider>
    </RpcGate>
  ),
})

// Placeholder logos until real connected apps are wired in.
const placeholderLogos = [0, 1, 2].map((i) => <span key={i} className="size-5 rounded-full bg-kumo-fill" />)

const AppFrame = () => {
  const { user } = useApi()
  const workspaces = useWorkspaces()
  const navigate = useNavigate()
  const { workspaceId } = useParams({ strict: false })

  // One workspace is one conversation, so each is listed by its title and when it was last active.
  const conversations =
    workspaces.status === 'ready'
      ? workspaces.workspaces.map(({ id, title, lastActive }) => ({
          id,
          title,
          workspaceLabel: workspaceLabel(title),
          subtitle: formatActivity(lastActive),
        }))
      : []
  const notice =
    workspaces.status === 'failed'
      ? `Couldn’t load conversations: ${workspaces.message}`
      : workspaces.status === 'ready' && conversations.length === 0
        ? 'No conversations yet.'
        : undefined

  return (
    <AppShell
      sidebar={
        <Sidebar
          user={{ name: user.name }}
          conversations={conversations}
          selectedConversationId={workspaceId}
          onSelectConversation={(id) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id } })}
          notice={notice}
          connections={placeholderLogos}
        />
      }
    >
      <Outlet />
    </AppShell>
  )
}
