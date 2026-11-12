import { useState, type ReactNode } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import { UserMessage } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

export type NewChatPaneProps = {
  header?: ReactNode
  /** Greet with this and the composer in the middle of the page until the first message is sent. */
  greeting?: string
  /** Starts the conversation with its first message and the files it carries (see `startConversation`). */
  start: (text: string, files: File[], modelId: string) => Promise<StartedChat>
  /** The conversation exists: open it. */
  onStarted: (chat: StartedChat) => Promise<unknown>
}

/** The start of a conversation: sending the first message creates it, and it is then opened. */
export const NewChatPane = ({ header, greeting, start, onStarted }: NewChatPaneProps) => {
  const model = useDefaultModel()
  const refreshWorkspaces = useRefreshWorkspaces()
  // The message being sent, shown until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[] }>()
  const [problem, setProblem] = useState<string>()
  useDocumentTitle('New chat')

  const send = async (text: string, files: File[]) => {
    if (pending) return
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    setPending({ text, files })
    try {
      const started = await start(text, files, model.id)
      refreshWorkspaces()
      await onStarted(started)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
    }
  }

  const composerProblem = problem === undefined ? undefined : { message: problem, onDismiss: () => setProblem(undefined) }

  // Once something is said, it is shown as the conversation it becomes; if it could not be sent,
  // nothing was, and the page is as it was.
  if (greeting !== undefined && !pending) return <ChatStart greeting={greeting} onSend={send} problem={composerProblem} autoFocus />

  return (
    <ChatLayout header={header} composer={<Composer onSend={send} problem={composerProblem} />}>
      {/* Spaced like the conversation this becomes. */}
      <div className="flex flex-col gap-2">
        {pending && (
          <UserMessage
            parts={pending.text ? [{ type: 'text', text: pending.text }] : []}
            attachments={pending.files.map((file, index) => ({ id: String(index), name: file.name || 'Attached file', mimeType: file.type }))}
          />
        )}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
      </div>
    </ChatLayout>
  )
}
