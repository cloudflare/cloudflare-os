import { useState, type ReactNode } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import { UserMessage } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
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
  const connection = useConnectionNotice()
  // The message being sent, shown until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[] }>()
  const [problem, setProblem] = useState<string>()
  // A message that did not go, for the greeting's composer, which is gone while it is sent, to
  // start from when it comes back.
  const [unsent, setUnsent] = useState<{ text: string; files: File[] }>()
  useDocumentTitle('New chat')

  // Resolves to whether the conversation was started; the composer keeps the draft until it has.
  const send = async (text: string, files: File[]) => {
    if (pending || connection?.blocked()) return false
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    setPending({ text, files })
    try {
      const started = await start(text, files, model.id)
      refreshWorkspaces()
      await onStarted(started)
      return true
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
      setUnsent({ text, files })
      return false
    }
  }

  const composerProblem = problem === undefined ? undefined : { message: problem, onDismiss: () => setProblem(undefined) }

  // Once something is said, it is shown as the conversation it becomes; if it could not be sent,
  // nothing was, and the page is as it was.
  if (greeting !== undefined && !pending) {
    return (
      <StartLayout header={header}>
        <ChatStart greeting={greeting} onSend={send} initialDraft={unsent} problem={composerProblem} autoFocus />
      </StartLayout>
    )
  }

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
