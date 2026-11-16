import { useMemo, useState, type ReactNode } from 'react'
import type { MessageFormatRef } from '@gadgets/workshop-shared/api'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { MessageList } from '@/blocks/MessageList'
import { UserMessage, type UserMessageAttachment, type UserMessagePart } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { allSkills } from '@/skills/skillGroups'
import { useSkills } from '@/skills/SkillsContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { skillCommandOf } from './slashCommands'
import { describeModelProblem, modelFor } from './models'
import { startWithFormat, type StartFormat } from './startWithFormat'
import { useModels } from './useModels'

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

/**
 * The first message of a conversation just started, as it was drawn while it was sent: for the
 * conversation to draw it where it was until its own is read (`ChatPane`'s `sending`).
 */
export type SentMessage = { parts: UserMessagePart[]; attachments: UserMessageAttachment[] }

/** What the server calls a new chat until it gives it a title of its own. */
export const NEW_CHAT_TITLE = 'New Chat'

export type NewChatPaneProps = {
  header?: ReactNode
  /**
   * The header the conversation will have, shown while its first message is sent, so that the
   * conversation opens under the same one. Left out, `header`.
   */
  startedHeader?: ReactNode
  /** Greet with this and the composer in the middle of the page until the first message is sent. */
  greeting?: string
  /**
   * The format the first message asks for something as (a Document, a Spreadsheet, …), which the
   * composer starts with, and the way to start with none after all.
   */
  format?: StartFormat & { onRemove: () => void }
  /**
   * Starts the conversation with its first message and the files it carries, `formats` saying
   * where the message names a format; or with a skill and the words it is given (see
   * `startConversation`).
   */
  start: (text: string, files: File[], modelId: string, command?: ComposerCommand, formats?: MessageFormatRef[]) => Promise<StartedChat>
  /** A skill chosen elsewhere, such as on its page, to start with. */
  initialCommand?: ComposerCommand
  /** The conversation exists: open it, drawing `sent` as it was until its own is read. */
  onStarted: (chat: StartedChat, sent: SentMessage) => Promise<unknown>
  /** Under the greeting's composer, such as where the chat will go. */
  below?: ReactNode
  /** Apart from the composer, further down (`ChatStart`'s `after`), such as blueprints to start from. */
  after?: ReactNode
}

/** The start of a conversation: sending the first message creates it, and it is then opened. */
export const NewChatPane = ({ header, startedHeader, greeting, format, start, onStarted, initialCommand, below, after }: NewChatPaneProps) => {
  const { models, prefer } = useModels()
  // The model chosen here, which also becomes the one every new chat starts with.
  const [picked, setPicked] = useState<string>()
  const model = modelFor(models, { picked })
  const commands = useLibraryCommands()
  const refreshWorkspaces = useRefreshWorkspaces()
  const connection = useConnectionNotice()
  // The message being sent, as it was written and with the skill or format it started with, shown
  // until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[]; command?: ComposerCommand; format?: StartFormat }>()
  const [problem, setProblem] = useState<string>()
  // A message that did not go, for the greeting's composer, which is gone while it is sent, to
  // start from when it comes back.
  const [unsent, setUnsent] = useState<{ text: string; files: File[]; command?: ComposerCommand } | undefined>(initialCommand && { text: '', files: [], command: initialCommand })
  useDocumentTitle('New chat')

  // Resolves to whether the conversation was started; the composer keeps the draft until it has.
  const send = async (text: string, files: File[], command?: ComposerCommand) => {
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
      const started = await start(message.text, files, model.model.id, command, message.formats)
      refreshWorkspaces()
      await onStarted(started, sentOf({ text, files, command, format: asked }))
      return true
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
      setUnsent({ text, files, command })
      return false
    }
  }

  const addActions = models.status === 'ready' && model.status === 'ready' && models.offered.length > 1 ? {
    model: {
      models: models.offered,
      current: model.model.id,
      onChoose: (id: string) => {
        setPicked(id)
        // It still answers this chat when it cannot be kept for the next.
        prefer(id).catch((error: unknown) => setProblem(`Couldn’t make it your default model: ${error instanceof Error ? error.message : String(error)}`))
      },
    },
  } : undefined

  const composerProblem = problem === undefined ? undefined : { message: problem, onDismiss: () => setProblem(undefined) }

  // Once something is said, it is shown as the conversation it becomes; if it could not be sent,
  // nothing was, and the page is as it was.
  if (greeting !== undefined && !pending) {
    return (
      <StartLayout header={header}>
        <ChatStart greeting={greeting} onSend={send} initialDraft={unsent} commands={commands} format={format} problem={composerProblem} addActions={addActions} below={below} after={after} autoFocus />
      </StartLayout>
    )
  }

  const sent = pending && sentOf(pending)
  return (
    // The message being sent has its format in it, so the composer under it starts with none.
    <ChatLayout header={pending ? startedHeader ?? header : header} composer={<Composer onSend={send} initialDraft={unsent} commands={commands} format={pending ? undefined : format} problem={composerProblem} addActions={addActions} />}>
      {/* In the list the conversation will be in, under its header, so that it opens where this is. */}
      <MessageList messages={[]}>
        {sent && <UserMessage parts={sent.parts} attachments={sent.attachments} />}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
      </MessageList>
    </ChatLayout>
  )
}

// A message being sent as it is drawn: the skill or the format as what it is, then what was written.
const sentOf = ({ text, files, command, format }: { text: string; files: File[]; command?: ComposerCommand; format?: StartFormat }): SentMessage => {
  const lead: UserMessagePart | undefined = command
    ? { type: 'command', name: command.name }
    : format && { type: 'format', noun: format.noun, icon: format.icon }
  return {
    parts: [...(lead ? [lead] : []), ...(text ? [{ type: 'text' as const, text: lead ? ` ${text}` : text }] : [])],
    attachments: files.map((file, index) => ({ id: String(index), name: file.name || 'Attached file', mimeType: file.type })),
  }
}

/**
 * The user's skills, as a composer with no workspace yet offers them: from the Library, each said
 * to be from where it is kept. The workspace the first message makes knows them by the same ids.
 */
const useLibraryCommands = (): ComposerCommand[] => {
  const { snapshot } = useSkills()
  const collections = snapshot.status === 'ready' ? snapshot.collections : undefined
  return useMemo(() => (collections ? allSkills(collections) : [])
    .map(({ skill, collection }) => skillCommandOf(skill, collection.title))
    .toSorted((a, b) => a.title.localeCompare(b.title)), [collections])
}
