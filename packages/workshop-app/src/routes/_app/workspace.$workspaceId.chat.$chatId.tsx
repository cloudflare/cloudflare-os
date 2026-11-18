import { useCallback, useState } from 'react'
import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { formatAsideRef, isApp, itemPage, validateAsideParam } from '@/aside/asideItems'
import { carryAside, useAsideNavigation } from '@/aside/useAsideNavigation'
import type { ActionItem, ChatAttachment, ConnectionItem, HookItem, OutputItem } from '@/chat/chatItems'
import { ChatPane } from '@/chat/ChatPane'
import { useApproveCreation } from '@/connections/ApproveCreation'
import { SetUpConnection, type ConnectionRequest } from '@/connections/SetUpConnection'

/**
 * One chat in a workspace, and what is shown beside it (`?open=`, see `asideItems`), which the
 * frame lays out (`_app`).
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/chat/$chatId')({
  params: {
    parse: ({ workspaceId, chatId }) => {
      const id = Number(chatId)
      if (!Number.isSafeInteger(id) || id < 0) throw notFound()
      return { workspaceId, chatId: id }
    },
    stringify: ({ workspaceId, chatId }) => ({ workspaceId, chatId: String(chatId) }),
  },
  validateSearch: (search: Record<string, unknown>): { open?: string } => ({ open: validateAsideParam(search.open) }),
  component: WorkspaceChat,
})

function WorkspaceChat() {
  const { workspaceId, chatId } = Route.useParams()
  const initialTitle = useLocation({ select: (location) => location.state.chatTitle })
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  // Stable, or every row of the chat renders again.
  const openAttachment = useCallback(
    (file: ChatAttachment) => aside.show(formatAsideRef({ kind: 'file', fileId: file.id }), { workspaceId, chatId }),
    [aside, workspaceId, chatId],
  )
  const openOutput = useCallback(
    (output: OutputItem) => aside.show(formatAsideRef({ kind: 'output', workpieceId: output.workpieceId }), { workspaceId, chatId }),
    [aside, workspaceId, chatId],
  )
  const openAutomation = useCallback((hook: HookItem) => void navigate({ to: '/automations', search: { q: hook.title } }), [navigate])
  const automationHref = useCallback((hook: HookItem) => router.buildLocation({ to: '/automations', search: { q: hook.title } }).href, [router])
  const outputHref = useCallback(
    (output: OutputItem) =>
      router.buildLocation({ ...itemPage(workspaceId, { kind: 'output', workpieceId: output.workpieceId }, isApp(output)), search: { chat: chatId } }).href,
    [router, workspaceId, chatId],
  )
  // The connection request being set up, kept as the dialog closes so that it does not change as
  // it goes, and left behind with its chat.
  const at = `${workspaceId}/${chatId}`
  const [setUp, setSetUp] = useState<{ at: string; request: ConnectionRequest; open: boolean }>()
  const setUpConnection = useCallback((request: ConnectionItem) => setSetUp({ at, request, open: true }), [at])
  const { approveCreation, dialog: creationDialog } = useApproveCreation(workspaceId)
  const approveAsCreation = useCallback(
    ({ actionId, title, creation }: ActionItem & { creation: { gatekeeperId: number } }) => approveCreation({ actionId, title, gatekeeperId: creation.gatekeeperId }),
    [approveCreation],
  )
  return (
    <>
    <ChatPane
      // Keyed, so each chat gets its own session rather than reusing the previous one's.
      key={`${workspaceId}/${chatId}`}
      workspaceId={workspaceId}
      chatId={chatId}
      initialTitle={initialTitle}
      // What the workspace has made that is shown beside the chat stays beside the workspace. Read
      // when asked for, so that showing something does not render the chat again.
      onOpenWorkspace={() =>
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { open: carryAside(router.state.location.search.open, { workspaceId }) } })
      }
      onOpenAgent={(agentKey) => navigate({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId, agentKey } })}
      onOpenAgents={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'agents' } })}
      // To its workspace's page, which lists what is left, in the deleted chat's place in the history.
      onDeleted={() =>
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { open: carryAside(router.state.location.search.open, { workspaceId }) }, replace: true })
      }
      onOpenSettings={() =>
        navigate({ to: '/workspace/$workspaceId/chat/$chatId/settings', params: { workspaceId, chatId }, search: {}, state: { fromChat: true } })
      }
      onOpenAttachment={openAttachment}
      onOpenOutput={openOutput}
      outputHref={outputHref}
      // An automation is listed on the Automations page, searched for by its title.
      onOpenAutomation={openAutomation}
      automationHref={automationHref}
      onSetUpConnection={setUpConnection}
      onApproveCreation={approveAsCreation}
    />
    {creationDialog}
    {setUp?.at === at && (
      <SetUpConnection
        key={setUp.request.requestId}
        workspaceId={workspaceId}
        request={setUp.request}
        open={setUp.open}
        onOpenChange={(open) => setSetUp((current) => current && { ...current, open })}
      />
    )}
    </>
  )
}
