import { useRef } from 'react'
import { Mascot } from '@/components/mascot/Mascot'
import { Composer, type ComposerHandle, type ComposerProps } from './Composer'
import { StarterTasks, type StarterTask } from './StarterTasks'
import { WorkspacePicker, type WorkspacePickerProps } from './WorkspacePicker'

export type ChatStartProps = {
  /** What the page says to whoever is starting, e.g. "Hello Ada, what should we do today?" */
  greeting: string
  onSend: ComposerProps['onSend']
  /** What the draft starts with, such as a first message that did not go. */
  initialDraft?: ComposerProps['initialDraft']
  /** The skills and commands the first message can be sent with. */
  commands?: ComposerProps['commands']
  /** The format the first message asks for something as, such as a Document. */
  format?: ComposerProps['format']
  /** Why the first message did not go. */
  problem?: ComposerProps['problem']
  /** Put the cursor in the composer once it is shown. */
  autoFocus?: boolean
  /** The workspace the conversation starts in, where that is still to choose. */
  workspace?: WorkspacePickerProps
  /** Work to start from, under everything else; choosing one writes it in the composer. */
  starters?: readonly StarterTask[]
}

/**
 * Somewhere to start from nothing: the mascot and a greeting over the composer, in the middle of
 * the page, and under the composer the workspace it starts in, where there is a choice of one,
 * then a few things to start with.
 */
export const ChatStart = ({ greeting, onSend, initialDraft, commands, format, problem, autoFocus, workspace, starters }: ChatStartProps) => {
  const composer = useRef<ComposerHandle>(null)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-3">
      <div className="flex w-full max-w-md flex-col items-center">
        {/* Small on a page that is mostly empty, so it notices a pointer from well away. */}
        <Mascot emotion="idle" color="brand" interactive reach={4} className="w-12 -mt-12" />
        <h1 className="mt-5 text-center text-lg/6 font-medium text-kumo-default">{greeting}</h1>
        <div className="mt-7 w-full">
          <Composer ref={composer} onSend={onSend} initialDraft={initialDraft} commands={commands} format={format} problem={problem} autoFocus={autoFocus} />
        </div>
        {workspace && (
          <div className="mt-6 flex w-full justify-center">
            <WorkspacePicker {...workspace} />
          </div>
        )}
        {starters && starters.length > 0 && (
          <div className="mt-8 w-full">
            <StarterTasks tasks={starters} onPick={({ prompt }) => composer.current?.fillDraft(prompt)} />
          </div>
        )}
      </div>
    </div>
  )
}
