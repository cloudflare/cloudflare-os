import { useState, type ReactNode } from 'react'
import type { MessageFormatRef } from '@gadgets/workshop-shared/api'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart, type ChatStartProps } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import { UserMessage, type UserMessagePart } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { startWithFormat, type StartFormat } from './startWithFormat'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

export type NewChatPaneProps = {
  header?: ReactNode
  /** Greet with this and the composer in the middle of the page until the first message is sent. */
  greeting?: string
  /**
   * The format the first message asks for something as (a Document, a Spreadsheet, …), which the
   * composer starts with, and the way to start with none after all.
   */
  format?: StartFormat & { onRemove: () => void }
  /** The workspace the conversation starts in, where that is still to choose, under the greeting's composer. */
  workspace?: ChatStartProps['workspace']
  /**
   * Starts the conversation with its first message and the files it carries, `formats` saying
   * where the message names a format (see `startConversation`).
   */
  start: (text: string, files: File[], modelId: string, formats?: MessageFormatRef[]) => Promise<StartedChat>
  /** The conversation exists: open it. */
  onStarted: (chat: StartedChat) => Promise<unknown>
}

/** The start of a conversation: sending the first message creates it, and it is then opened. */
export const NewChatPane = ({ header, greeting, format, workspace, start, onStarted }: NewChatPaneProps) => {
  const model = useDefaultModel()
  const refreshWorkspaces = useRefreshWorkspaces()
  const connection = useConnectionNotice()
  // The message being sent, as it was written and with the format it started with, shown until
  // the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[]; format?: StartFormat }>()
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
    setPending({ text, files, format })
    try {
      const message = format ? startWithFormat(format, text) : { text, formats: undefined }
      const started = await start(message.text, files, model.id, message.formats)
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
        <ChatStart greeting={greeting} onSend={send} initialDraft={unsent} format={format} problem={composerProblem} workspace={workspace} autoFocus />
      </StartLayout>
    )
  }

  // As the message will be drawn: the format as what it is, then what was written.
  const pendingParts: UserMessagePart[] = pending
    ? [
        ...(pending.format ? [{ type: 'format' as const, noun: pending.format.noun, icon: pending.format.icon }] : []),
        ...(pending.text ? [{ type: 'text' as const, text: pending.format ? ` ${pending.text}` : pending.text }] : []),
      ]
    : []

  return (
    // The message being sent has its format in it, so the composer under it starts with none.
    <ChatLayout header={header} composer={<Composer onSend={send} format={pending ? undefined : format} problem={composerProblem} />}>
      {/* Spaced like the conversation this becomes. */}
      <div className="flex flex-col gap-2">
        {pending && (
          <UserMessage
            parts={pendingParts}
            attachments={pending.files.map((file, index) => ({ id: String(index), name: file.name || 'Attached file', mimeType: file.type }))}
          />
        )}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
      </div>
    </ChatLayout>
  )
}
