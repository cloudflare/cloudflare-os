import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { startConversation } from '@/chat/startConversation'
import { describeModelProblem, useDefaultModel } from '@/chat/useDefaultModel'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'

/** The start of a new conversation: sending the first message creates it and opens it. */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { api } = useApi()
  const model = useDefaultModel()
  const refreshWorkspaces = useRefreshWorkspaces()
  const navigate = useNavigate()
  // The message being sent, shown until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const send = async (text: string) => {
    if (pending) return
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    setPending(text)
    try {
      const { workspaceId, chatId } = await startConversation(() => api.newWorkspace(), text, model.id)
      refreshWorkspaces()
      await navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId, chatId } })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
    }
  }

  return (
    <ChatLayout composer={<Composer onSend={send} />}>
      {pending && (
        <>
          <MessageBubble role="user">{pending}</MessageBubble>
          <ThinkingIndicator />
        </>
      )}
      {problem && <MessageBubble role="error">{problem}</MessageBubble>}
    </ChatLayout>
  )
}
