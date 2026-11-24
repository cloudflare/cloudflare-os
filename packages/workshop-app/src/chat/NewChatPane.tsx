import { useRef, useState, type ReactNode } from 'react'
import type { MessageFormatRef, SlashCommandChoice } from '@gadgets/workshop-shared/api'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart, type ChatStartProps } from '@/blocks/ChatStart'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { AddConnection, type AddedConnection } from '@/connections/AddConnection'
import type { AddableService } from '@/connections/connectionChoices'
import { ConnectResource } from '@/connections/SetUpConnection'
import type { ComposerCommand } from '@/blocks/composerCommand'
import { MessageList } from '@/blocks/MessageList'
import { UserMessage, type UserMessagePart } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { DraftConnection } from './startConversation'
import { THINKING } from './statusWords'
import { handOverFirstMessage, type FirstMessage } from './firstMessage'
import { startWithFormat, type StartFormat } from './startWithFormat'
import { ComposerModelPicker } from './ComposerModelPicker'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatCommands } from './useChatCommands'
import { useLinkConnections } from './useLinkConnections'
import { useComposerOffers } from './useComposerOffers'

// The words of a message, as the parts it is drawn in, those there are.
const words = (text: string): UserMessagePart[] => (text ? [{ type: 'text', text }] : [])

// As the message will be drawn: the skill as what it is, then what was written; or what is sent
// for a format or a template (`startWithFormat`), with its name as what it is.
const shownOf = ({ text, files, command, format }: { text: string; files: File[]; command?: ComposerCommand; format?: StartFormat }): FirstMessage => {
  const named = !command && format ? startWithFormat(format, text) : undefined
  const at = named?.formats[0]
  return {
    parts: command
      ? [{ type: 'command', name: command.name }, ...words(text && ` ${text}`)]
      : named && at
        ? [...words(named.text.slice(0, at.position)), { type: 'format', noun: at.noun, icon: at.icon }, ...words(named.text.slice(at.position + at.length))]
        : words(text),
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
 * is made for it as its composer is first pointed at or written in, so that its commands are
 * read by the time they are looked for, and never for a page that is only seen.
 */
export const NewChatPane = ({ header, sendingHeader = header, greeting, format, workspace, start, onStarted, startIn, listCommands, ensureWorkspace, initialText }: NewChatPaneProps) => {
  const model = useDefaultModel()
  // Until they are read, the + menu's list of them says so.
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
  // Add a connection is open, at the service chosen for it; and the connections made for the draft,
  // by their pill's key.
  const composer = useRef<ComposerHandle>(null)
  const [adding, setAdding] = useState<{ open: boolean; start?: AddableService }>({ open: false })
  const added = useRef(new Map<string, AddedConnection>())
  // Put away, it keeps the service it was at, whose page is the one that closes.
  const [changeAdding] = useState(() => (open: boolean) => setAdding((current) => ({ ...current, open })))
  const [onAdded] = useState(() => async (made: AddedConnection) => {
    // By the workspace too, as each numbers its own: one made in another is not this one.
    const key = `gatekeeper:${made.workspaceId}:${made.gatekeeperId}`
    added.current.set(key, made)
    composer.current?.addConnection({ key, title: made.description.title, kind: made.kind, service: made.service, snippet: made.description.snippet })
  })
  // A connection is made in the workspace the chat starts in, which is made for it where there is none yet.
  const connect = (service: AddableService) => {
    if (startIn !== undefined) return setAdding({ open: true, start: service })
    if (!ensureWorkspace || connection?.blocked()) return
    setProblem(undefined)
    ensureWorkspace().then(() => setAdding({ open: true, start: service }), (error: unknown) => setProblem(`Couldn’t add a connection: ${error instanceof Error ? error.message : String(error)}`))
  }
  // The format or the template chosen from the + menu, in place of the one the page opened with.
  // Its formats and templates are read once the composer is pointed at or written in.
  const [chosen, setChosen] = useState<StartFormat>()
  const startsWith = chosen ?? format
  const [offersWanted, setOffersWanted] = useState(false)
  const offers = useComposerOffers({ wanted: offersWanted, builds: startIn !== undefined || ensureWorkspace !== undefined, onConnect: connect, onStartWith: setChosen, onDraft: (text) => composer.current?.appendToDraft(text) })
  const addActions = { offers }
  // The draft says when it no longer starts with it, its pill deleted, or does again.
  const composerFormat = {
    value: startsWith && { noun: startsWith.noun, icon: startsWith.icon, template: startsWith.template, description: startsWith.description },
    onChange: (next: StartFormat | undefined) => {
      setChosen(next)
      if (!next) format?.onRemove()
    },
  }
  // A link in the first message is a connection as in any other, the workspace made for the first of them.
  const links = useLinkConnections(startIn, composer, added, ensureWorkspace)
  const linkForm = links?.form && <ConnectResource {...links.form} />
  // A failure leaves the commands unread; sending still makes the workspace as it goes.
  const onCommandsWanted = () => {
    setOffersWanted(true)
    if (startIn === undefined) void ensureWorkspace?.().catch(() => undefined)
  }

  // Resolves to whether the conversation was started; the composer keeps the draft until it has.
  const send = async (text: string, files: File[], command?: ComposerCommand, connections?: ComposerConnection[]) => {
    if (pending || connection?.blocked()) return false
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    // A skill is sent as itself, so a format does not go with it.
    const asked: StartFormat | undefined = command || !startsWith ? undefined : { noun: startsWith.noun, icon: startsWith.icon, template: startsWith.template }
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
        <ChatStart ref={composer} greeting={greeting} onSend={send} initialDraft={unsent} commands={commands} commandsLoading={commandsLoading} onCommandsWanted={onCommandsWanted} format={composerFormat} problem={composerProblem} workspace={workspace} addActions={addActions} links={links?.draft} endSlot={modelPicker} autoFocus />
        {startIn !== undefined && <AddConnection workspaceId={startIn} open={adding.open} start={adding.start} onOpenChange={changeAdding} to="this chat" onAdded={onAdded} />}
        {linkForm}
      </StartLayout>
    )
  }

  return (
    // The message being sent has its format in it, so the composer under it starts with none.
    // Its links are the greeting's composer's, where that is what was sent from.
    <ChatLayout header={sendingHeader} composer={<Composer ref={composer} onSend={send} commands={commands} commandsLoading={commandsLoading} onCommandsWanted={onCommandsWanted} format={pending ? undefined : composerFormat} problem={composerProblem} addActions={addActions} links={greeting === undefined ? links?.draft : undefined} endSlot={modelPicker} />}>
      {/* In the conversation's own list, so it is where the conversation this becomes will be. */}
      <MessageList messages={[]}>
        {pending && <UserMessage {...shownOf(pending)} />}
        <AssistantPresence working={Boolean(pending)} status={THINKING} />
      </MessageList>
      {greeting === undefined && linkForm}
    </ChatLayout>
  )
}
