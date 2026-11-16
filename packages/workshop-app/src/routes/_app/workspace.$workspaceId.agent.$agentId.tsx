import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { AgentPane } from '@/automations/AgentPane'
import { useAutomationLink } from '../-automationLink'

/** An agent a workspace's gadgets and chats call on, on a page of its own, opened from Automations. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/agent/$agentId')({
  params: {
    parse: ({ workspaceId, agentId }) => {
      const id = Number(agentId)
      if (!Number.isSafeInteger(id) || id < 0) throw notFound()
      return { workspaceId, agentId: id }
    },
    stringify: ({ workspaceId, agentId }) => ({ workspaceId, agentId: String(agentId) }),
  },
  component: AgentPage,
})

function AgentPage() {
  const { workspaceId, agentId } = Route.useParams()
  const navigate = useNavigate()
  const link = useAutomationLink()
  return (
    <AgentPane
      key={`${workspaceId}/${agentId}`}
      workspaceId={workspaceId}
      agentId={agentId}
      link={link}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
    />
  )
}
