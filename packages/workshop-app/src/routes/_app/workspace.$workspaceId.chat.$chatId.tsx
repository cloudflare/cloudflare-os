import { useCallback } from 'react'
import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { formatAsideRef, isApp, itemPage, validateAsideParam } from '@/aside/asideItems'
import { useAsideNavigation } from '@/aside/useAsideNavigation'
import type { ChatAttachment, OutputItem } from '@/chat/chatItems'
import { ChatPane } from '@/chat/ChatPane'

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
  const outputHref = useCallback(
    (output: OutputItem) =>
      router.buildLocation({ ...itemPage(workspaceId, { kind: 'output', workpieceId: output.workpieceId }, isApp(output)), search: { chat: chatId } }).href,
    [router, workspaceId, chatId],
  )
  return (
    <ChatPane
      // Keyed, so each chat gets its own session rather than reusing the previous one's.
      key={`${workspaceId}/${chatId}`}
      workspaceId={workspaceId}
      chatId={chatId}
      initialTitle={initialTitle}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      onOpenAttachment={openAttachment}
      onOpenOutput={openOutput}
      outputHref={outputHref}
    />
  )
}
