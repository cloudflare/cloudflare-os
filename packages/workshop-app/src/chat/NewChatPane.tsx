import { useState, type ReactNode } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

export type NewChatPaneProps = {
  header?: ReactNode
  /** Greet with this and the composer in the middle of the page until the first message is sent. */
  greeting?: string
  /** Starts the conversation with its first message (see `startConversation`). */
  start: (text: string, modelId: string) => Promise<StartedChat>
  /** The conversation exists: open it. */
  onStarted: (chat: StartedChat) => Promise<unknown>
}

/** The start of a conversation: sending the first message creates it, and it is then opened. */
export const NewChatPane = ({ header, greeting, start, onStarted }: NewChatPaneProps) => {
  const model = useDefaultModel()
  const refreshWorkspaces = useRefreshWorkspaces()
  // The message being sent, shown until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const send = async (text: string) => {
    if (pending) return
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    setPending(text)
    try {
      const started = await start(text, model.id)
      refreshWorkspaces()
      await onStarted(started)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
    }
  }

  // Once something is said, it is shown as the conversation it becomes.
  if (greeting !== undefined && !pending && !problem) return <ChatStart greeting={greeting} onSend={send} autoFocus />

  return (
    <ChatLayout header={header} composer={<Composer onSend={send} />}>
      {/* Spaced like the conversation this becomes. */}
      <div className="flex flex-col gap-2">
        {pending && <MessageBubble role="user">{pending}</MessageBubble>}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
        {problem && <MessageBubble role="error">{problem}</MessageBubble>}
      </div>
    </ChatLayout>
  )
}
