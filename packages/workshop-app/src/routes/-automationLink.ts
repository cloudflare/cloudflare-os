import { useNavigate, useRouter } from '@tanstack/react-router'
import { itemPage } from '@/aside/asideItems'
import type { AutomationLink } from '@/automations/AutomationsTab'

/**
 * Where an automation reports, as its row opens it: the chat it runs in, or the gadget whose code
 * it wakes, on the gadget's own page; or an agent's page.
 */
export const useAutomationLink = (): AutomationLink => {
  const navigate = useNavigate()
  const router = useRouter()
  return (workspaceId, place) => {
    const to = place.type === 'chat'
      ? ({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: place.chatId } } as const)
      : place.type === 'agent'
        ? ({ to: '/workspace/$workspaceId/agent/$agentId', params: { workspaceId, agentId: place.agentId } } as const)
        : itemPage(workspaceId, { kind: 'output', workpieceId: place.gadgetId }, true)
    return { href: router.buildLocation(to).href, onOpen: () => void navigate(to) }
  }
}
