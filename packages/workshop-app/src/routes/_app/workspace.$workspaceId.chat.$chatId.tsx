import { useCallback, useMemo, useState } from 'react'
import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { formatAsideRef, isApp, itemPage, parseAsideRef, validateAsideParam } from '@/aside/asideItems'
import { useAsideNavigation } from '@/aside/useAsideNavigation'
import type { ChatAttachment, MadeFile, OutputItem } from '@/chat/chatItems'
import { ChatPane } from '@/chat/ChatPane'
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
  const sending = useLocation({ select: (location) => location.state.sending })
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  const { open } = Route.useSearch()
  // Kept while the same file is open, or every row of the chat renders again.
  const shownBeside = useMemo(() => {
    const shown = parseAsideRef(open)
    return shown?.kind === 'connected' ? { gatekeeperId: shown.gatekeeperId, subjectId: shown.subjectId } : undefined
  }, [open])
  // Stable, or every row of the chat renders again.
  const openAttachment = useCallback(
    (file: ChatAttachment) => aside.show(formatAsideRef({ kind: 'file', fileId: file.id }), { workspaceId, chatId }),
    [aside, workspaceId, chatId],
  )
  const openOutput = useCallback(
    (output: OutputItem) => aside.show(formatAsideRef({ kind: 'output', workpieceId: output.workpieceId }), { workspaceId, chatId }),
    [aside, workspaceId, chatId],
  )
  const openMade = useCallback(
    (file: MadeFile) => aside.show(formatAsideRef({ kind: 'connected', gatekeeperId: file.gatekeeperId, subjectId: file.subjectId }), { workspaceId, chatId }),
    [aside, workspaceId, chatId],
  )
  const madeHref = useCallback(
    (file: MadeFile) =>
      router.buildLocation({ ...itemPage(workspaceId, { kind: 'connected', gatekeeperId: file.gatekeeperId, subjectId: file.subjectId }, false), search: { chat: chatId } }).href,
    [router, workspaceId, chatId],
  )
  const outputHref = useCallback(
    (output: OutputItem) =>
      router.buildLocation({ ...itemPage(workspaceId, { kind: 'output', workpieceId: output.workpieceId }, isApp(output)), search: { chat: chatId } }).href,
    [router, workspaceId, chatId],
  )
  const openChat = useCallback(
    (id: number) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }),
    [navigate, workspaceId],
  )
  const chatHref = useCallback(
    (id: number) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }).href,
    [router, workspaceId],
  )
  // The connection request being set up, kept as the dialog closes, and left behind with its chat.
  const at = `${workspaceId}/${chatId}`
  const [setUp, setSetUp] = useState<{ at: string; request: ConnectionRequest; open: boolean }>()
  const setUpConnection = useCallback((request: ConnectionRequest) => setSetUp({ at, request, open: true }), [at])
  return (
    <>
      <ChatPane
        // Keyed, so each chat gets its own session rather than reusing the previous one's.
        key={at}
        workspaceId={workspaceId}
        chatId={chatId}
        initialTitle={initialTitle}
        sending={sending}
        onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
        onOpenAgent={(agentId) => navigate({ to: '/workspace/$workspaceId/agent/$agentId', params: { workspaceId, agentId } })}
        onOpenSettings={(tab) => navigate({ to: '/workspace/$workspaceId/chat/$chatId/settings', params: { workspaceId, chatId }, search: { tab }, state: { fromChat: true } })}
        onOpenAttachment={openAttachment}
        onOpenOutput={openOutput}
        onOpenMade={openMade}
        shownBeside={shownBeside}
        madeHref={madeHref}
        outputHref={outputHref}
        onSetUpConnection={setUpConnection}
        onOpenChat={openChat}
        chatHref={chatHref}
        workspaceLink={new URL(router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href, window.location.origin).href}
      />
      {setUp?.at === at && (
        <SetUpConnection
          key={setUp.request.requestId}
          workspaceId={workspaceId}
          chatId={chatId}
          request={setUp.request}
          open={setUp.open}
          onOpenChange={(open) => setSetUp((current) => current && { ...current, open })}
        />
      )}
    </>
  )
}
