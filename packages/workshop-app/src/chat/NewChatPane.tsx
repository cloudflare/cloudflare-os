import { useRef, useState, type ReactNode } from 'react'
import type { MessageFormatRef, SlashCommandChoice } from '@gadgets/workshop-shared/api'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart, type ChatStartProps } from '@/blocks/ChatStart'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { AddConnection, type AddedConnection } from '@/connections/AddConnection'
import { ConnectResource } from '@/connections/SetUpConnection'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { MessageList } from '@/blocks/MessageList'
import { UserMessage, type UserMessagePart } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { DraftConnection } from './startConversation'
import { handOverFirstMessage, type FirstMessage } from './firstMessage'
import { startWithFormat, type StartFormat } from './startWithFormat'
import { ComposerModelPicker } from './ComposerModelPicker'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatCommands } from './useChatCommands'
import { useLinkConnections } from './useLinkConnections'

// As the message will be drawn: the skill or the format as what it is, then what was written.
const shownOf = ({ text, files, command, format }: { text: string; files: File[]; command?: ComposerCommand; format?: StartFormat }): FirstMessage => {
  const lead: UserMessagePart | undefined = command
    ? { type: 'command', name: command.name }
    : format && { type: 'format', noun: format.noun, icon: format.icon }
  return {
    parts: [...(lead ? [lead] : []), ...(text ? [{ type: 'text' as const, text: lead ? ` ${text}` : text }] : [])],
    attachments: files.map((file, index) => ({ id: String(index), name: file.name || 'Attached file', mimeType: file.type })),
  }
}

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

/** What a chat is called until it is given a title. */
export const NEW_CHAT_TITLE = 'New Chat'

export type NewChatPaneProps = {
  header?: ReactNode
  /**
   * Over the message while it is sent, where `header` is for the greeting: as the chat's header
   * will be, so that nothing moves as it opens.
   */
  sendingHeader?: ReactNode
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
   * where the message names a format and `connections` what it is given, wherever each was made;
   * or with a skill and the words it is given (see `startConversation`).
   */
  start: (text: string, files: File[], modelId: string, command?: ComposerCommand, formats?: MessageFormatRef[], connections?: DraftConnection[]) => Promise<StartedChat>
  /**
   * The workspace the conversation starts in, where it exists already, as one chosen or one made
   * for it (`ensureWorkspace`): its commands are offered, and where the user builds in it,
   * connections can be added to the first message, as to any other.
   */
  startIn?: string
  /** The commands of the workspace it starts in (`startIn`), each as that workspace knows it. */
  listCommands: () => Promise<SlashCommandChoice[]>
  /**
   * Makes the workspace it will start in, for one that has none yet, so that its commands can be
   * offered and connections added before the first message is sent: it is then given as
   * `startIn`. Rejects with why it could not.
   */
  ensureWorkspace?: () => Promise<void>
  /** What the composer starts with written in it, to be changed before it is sent. */
  initialText?: string
  /** The conversation exists: open it. */
  onStarted: (chat: StartedChat) => Promise<unknown>
}

/**
 * The start of a conversation: sending the first message creates it, and it is then opened. It
 * can start with one of the commands of the workspace it starts in; where there is none yet, one
 * is made for it as the commands are first looked for, never before.
 */
export const NewChatPane = ({ header, sendingHeader = header, greeting, format, workspace, start, onStarted, startIn, listCommands, ensureWorkspace, initialText }: NewChatPaneProps) => {
  const model = useDefaultModel()
  // Until they are read, the + menu keeps their room.
  const { commands, loading: commandsLoading } = useChatCommands(startIn ?? '', listCommands, startIn !== undefined)
  const connection = useConnectionNotice()
  // The message being sent, as it was written and with the skill or format it started with, shown
  // until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[]; command?: ComposerCommand; format?: StartFormat }>()
  const [problem, setProblem] = useState<string>()
  // A message that did not go, for the greeting's composer, which is gone while it is sent, to
  // start from when it comes back.
  const [unsent, setUnsent] = useState<{ text: string; files: File[]; command?: ComposerCommand } | undefined>(() => initialText ? { text: initialText, files: [] } : undefined)
  useDocumentTitle('New chat')
  // Add a connection is open; and the connections made for the draft, by their line's key.
  const composer = useRef<ComposerHandle>(null)
  const [adding, setAdding] = useState(false)
  const added = useRef(new Map<string, AddedConnection>())
  const [onAdded] = useState(() => async (made: AddedConnection) => {
    // By the workspace too, as each numbers its own: one made in another is not this one.
    const key = `gatekeeper:${made.workspaceId}:${made.gatekeeperId}`
    added.current.set(key, made)
    composer.current?.addConnection({ key, title: made.description.title, kind: made.kind, service: made.service })
  })
  const addActions = startIn !== undefined
    ? { onAddConnection: () => setAdding(true) }
    : ensureWorkspace && {
      onAddConnection: () => {
        if (connection?.blocked()) return
        setProblem(undefined)
        ensureWorkspace().then(() => setAdding(true), (error: unknown) => setProblem(`Couldn’t add a connection: ${error instanceof Error ? error.message : String(error)}`))
      },
    }
  // A link in the first message is a connection as in any other, the workspace made for the first of them.
  const links = useLinkConnections(startIn, composer, added, ensureWorkspace)
  const linkForm = links?.form && <ConnectResource {...links.form} />
  // A failure leaves the commands unread; sending still makes the workspace as it goes.
  const onCommandsWanted = startIn === undefined && ensureWorkspace
    ? () => void ensureWorkspace().catch(() => undefined)
    : undefined

  // Resolves to whether the conversation was started; the composer keeps the draft until it has.
  const send = async (text: string, files: File[], command?: ComposerCommand, connections?: ComposerConnection[]) => {
    if (pending || connection?.blocked()) return false
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    // A skill is sent as itself, so a format does not go with it.
    const asked = command ? undefined : format
    setPending({ text, files, command, format: asked })
    try {
      const message = asked ? startWithFormat(asked, text) : { text, formats: undefined }
      // The connections after the words, each where its capsule shows it. A skill takes none.
      const given = command ? [] : connections?.flatMap(({ key }) => added.current.get(key) ?? []) ?? []
      const started = await start(message.text, files, model.id, command, message.formats, given)
      // Drawn by the chat as it is here until its history is read, so it doesn't blink out.
      handOverFirstMessage(started.workspaceId, started.chatId, shownOf({ text, files, command, format: asked }))
      await onStarted(started)
      return true
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
      setUnsent({ text, files, command })
      return false
    }
  }

  // In developer mode, the model before the send button.
  const modelPicker = <ComposerModelPicker modelId={model.status === 'ready' ? model.id : undefined} onProblem={setProblem} />
  const composerProblem = problem === undefined ? undefined : { message: problem, onDismiss: () => setProblem(undefined) }

  // Once something is said, it is shown as the conversation it becomes; if it could not be sent,
  // nothing was, and the page is as it was.
  if (greeting !== undefined && !pending) {
    return (
      <StartLayout header={header}>
        <ChatStart ref={composer} greeting={greeting} onSend={send} initialDraft={unsent} commands={commands} commandsLoading={commandsLoading} onCommandsWanted={onCommandsWanted} format={format} problem={composerProblem} workspace={workspace} addActions={addActions} links={links?.draft} endSlot={modelPicker} autoFocus />
        {startIn !== undefined && <AddConnection workspaceId={startIn} open={adding} onOpenChange={setAdding} to="this chat" onAdded={onAdded} />}
        {linkForm}
      </StartLayout>
    )
  }

  return (
    // The message being sent has its format in it, so the composer under it starts with none.
    // Its links are the greeting's composer's, where that is what was sent from.
    <ChatLayout header={sendingHeader} composer={<Composer ref={composer} onSend={send} commands={commands} commandsLoading={commandsLoading} onCommandsWanted={onCommandsWanted} format={pending ? undefined : format} problem={composerProblem} addActions={addActions} links={greeting === undefined ? links?.draft : undefined} endSlot={modelPicker} />}>
      {/* In the conversation's own list, so it is where the conversation this becomes will be. */}
      <MessageList messages={[]}>
        {pending && <UserMessage {...shownOf(pending)} />}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
      </MessageList>
      {greeting === undefined && linkForm}
    </ChatLayout>
  )
}
