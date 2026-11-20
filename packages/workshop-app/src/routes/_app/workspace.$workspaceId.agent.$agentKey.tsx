import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { formatAsideRef } from '@/aside/asideItems'
import { asideFor } from '@/aside/useAsideNavigation'
import { AgentPane } from '@/automations/AgentPane'
import { usePreferences } from '@/prefs/UserPreferencesContext'

/**
 * One of a workspace's agents (`agentKey`, its spawner's id, as a gadget's settings name it):
 * what it is, and its runs.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/agent/$agentKey')({
  component: WorkspaceAgent,
})

const gadgetOpen = (gadgetId: number) => formatAsideRef({ kind: 'output', workpieceId: gadgetId })

function WorkspaceAgent() {
  const { workspaceId, agentKey } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const preferences = usePreferences()
  return (
    <AgentPane
      // Keyed, so each workspace reads its own agents rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      agentKey={agentKey}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'agents' } })}
      onOpenRun={({ chatId, title }) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId',
          params: { workspaceId, chatId },
          search: { open: asideFor(preferences, { workspaceId, chatId }) },
          state: { chatTitle: title },
        })
      }
      runHref={(chatId) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } }).href}
      // Beside its workspace's page, as what the workspace has made is shown from there.
      onOpenGadget={(gadgetId) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library', open: gadgetOpen(gadgetId) } })}
      gadgetHref={(gadgetId) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library', open: gadgetOpen(gadgetId) } }).href}
    />
  )
}
