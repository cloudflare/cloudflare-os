import { Mascot } from '@/components/mascot/Mascot'
import { Composer, type ComposerProps } from './Composer'
import { WorkspacePicker, type WorkspacePickerProps } from './WorkspacePicker'

export type ChatStartProps = {
  /** What the page says to whoever is starting, e.g. "Hello Ada, what should we do today?" */
  greeting: string
  onSend: ComposerProps['onSend']
  /** What the draft starts with, such as a first message that did not go. */
  initialDraft?: ComposerProps['initialDraft']
  /** The skills and commands the first message can be sent with. */
  commands?: ComposerProps['commands']
  /** The skills are still being read, so the + menu keeps their room. */
  commandsLoading?: ComposerProps['commandsLoading']
  /** A slash was typed or the + menu opened, for commands read only once they are looked for. */
  onCommandsWanted?: ComposerProps['onCommandsWanted']
  /** The format the first message asks for something as, such as a Document. */
  format?: ComposerProps['format']
  /** Why the first message did not go. */
  problem?: ComposerProps['problem']
  /** Put the cursor in the composer once it is shown. */
  autoFocus?: boolean
  /** The workspace the conversation starts in, where that is still to choose. */
  workspace?: WorkspacePickerProps
  /** What the composer's + menu offers besides files, such as adding a connection. */
  addActions?: ComposerProps['addActions']
  /** What the first message's links are made, where someone can tell. */
  links?: ComposerProps['links']
  /** What the composer has before its send button. */
  endSlot?: ComposerProps['endSlot']
  ref?: ComposerProps['ref']
}

/**
 * Somewhere to start from nothing: the mascot and a greeting over the composer, in the middle of
 * the page, and under the composer the workspace it starts in, where there is a choice of one.
 */
export const ChatStart = ({ greeting, onSend, initialDraft, commands, commandsLoading, onCommandsWanted, format, problem, autoFocus, workspace, addActions, links, endSlot, ref }: ChatStartProps) => (
  <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-3">
    <div className="flex w-full max-w-md flex-col items-center">
      {/* Small on a page that is mostly empty, so it notices a pointer from well away. */}
      <Mascot emotion="idle" color="brand" interactive reach={4} className="w-12 -mt-12" />
      <h1 className="mt-5 text-center text-lg/6 font-medium text-kumo-default">{greeting}</h1>
      <div className="mt-7 w-full">
        <Composer ref={ref} onSend={onSend} initialDraft={initialDraft} commands={commands} commandsLoading={commandsLoading} onCommandsWanted={onCommandsWanted} format={format} problem={problem} autoFocus={autoFocus} addActions={addActions} links={links} endSlot={endSlot} />
      </div>
      {workspace && (
        <div className="mt-6 flex w-full justify-center">
          <WorkspacePicker {...workspace} />
        </div>
      )}
    </div>
  </div>
)
