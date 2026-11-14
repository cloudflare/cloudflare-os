import { useMemo, useState, type ReactNode } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatStart } from '@/blocks/ChatStart'
import { Composer } from '@/blocks/Composer'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { UserMessage } from '@/blocks/UserMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { StartLayout } from '@/layouts/StartLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { allSkills } from '@/skills/skillGroups'
import { useSkills } from '@/skills/SkillsContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { skillCommandOf } from './slashCommands'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'

/** Where a conversation that was started is. */
export type StartedChat = { workspaceId: string; chatId: number }

export type NewChatPaneProps = {
  header?: ReactNode
  /** Greet with this and the composer in the middle of the page until the first message is sent. */
  greeting?: string
  /**
   * Starts the conversation with its first message and the files it carries, or with a skill and
   * the words it is given (see `startConversation`).
   */
  start: (text: string, files: File[], modelId: string, command?: ComposerCommand) => Promise<StartedChat>
  /** A skill chosen elsewhere, such as on its page, to start with. */
  initialCommand?: ComposerCommand
  /** The conversation exists: open it. */
  onStarted: (chat: StartedChat) => Promise<unknown>
}

/** The start of a conversation: sending the first message creates it, and it is then opened. */
export const NewChatPane = ({ header, greeting, start, onStarted, initialCommand }: NewChatPaneProps) => {
  const model = useDefaultModel()
  const commands = useLibraryCommands()
  const refreshWorkspaces = useRefreshWorkspaces()
  const connection = useConnectionNotice()
  // The message being sent, shown until the conversation opens; or why it could not be sent.
  const [pending, setPending] = useState<{ text: string; files: File[]; command?: ComposerCommand }>()
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
    setPending({ text, files, command })
    try {
      const started = await start(text, files, model.id, command)
      refreshWorkspaces()
      await onStarted(started)
      return true
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPending(undefined)
      setUnsent({ text, files, command })
      return false
    }
  }

  const composerProblem = problem === undefined ? undefined : { message: problem, onDismiss: () => setProblem(undefined) }

  // Once something is said, it is shown as the conversation it becomes; if it could not be sent,
  // nothing was, and the page is as it was.
  if (greeting !== undefined && !pending) {
    return (
      <StartLayout header={header}>
        <ChatStart greeting={greeting} onSend={send} initialDraft={unsent} commands={commands} problem={composerProblem} autoFocus />
      </StartLayout>
    )
  }

  return (
    <ChatLayout header={header} composer={<Composer onSend={send} initialDraft={unsent} commands={commands} problem={composerProblem} />}>
      {/* Spaced like the conversation this becomes. */}
      <div className="flex flex-col gap-2">
        {pending && (
          <UserMessage
            parts={[
              ...(pending.command ? [{ type: 'command', name: pending.command.name } as const] : []),
              ...(pending.text ? [{ type: 'text', text: pending.command ? ` ${pending.text}` : pending.text } as const] : []),
            ]}
            attachments={pending.files.map((file, index) => ({ id: String(index), name: file.name || 'Attached file', mimeType: file.type }))}
          />
        )}
        <AssistantPresence working={Boolean(pending)} status="Thinking…" />
      </div>
    </ChatLayout>
  )
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
