import type { ReactNode } from 'react'
import { Mascot } from '@/components/mascot/Mascot'
import { Composer, type ComposerProps } from './Composer'

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
  /** What the composer's + menu offers besides attaching files, such as the model. */
  addActions?: ComposerProps['addActions']
  /** The composer's handle, for what is added to the draft from outside, such as a connection once it is made. */
  composerRef?: ComposerProps['ref']
  /** Given the links pasted into the draft, to connect them (`ComposerProps.onPasteLinks`). */
  onPasteLinks?: ComposerProps['onPasteLinks']
  /** Put the cursor in the composer once it is shown. */
  autoFocus?: boolean
  /** Under the composer, such as where the chat will go (`WorkspacePicker`). */
  below?: ReactNode
  /**
   * Further down, apart from the composer, such as blueprints to start from: in the space under
   * it, so that the greeting and the composer stay where they are when it comes in.
   */
  after?: ReactNode
}

/** Somewhere to start from nothing: the mascot and a greeting over the composer, in the middle of the page. */
export const ChatStart = ({ greeting, onSend, initialDraft, commands, format, problem, addActions, composerRef, onPasteLinks, autoFocus, below, after }: ChatStartProps) => (
  // Centred between two rows that share what is left, so what comes in under it does not move it.
  <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto_1fr] justify-items-center p-3">
    <div className="row-start-2 flex w-full max-w-md flex-col items-center">
      {/* Small on a page that is mostly empty, so it notices a pointer from well away. */}
      <Mascot emotion="idle" color="brand" interactive reach={4} className="w-12 -mt-12" />
      <h1 className="mt-5 text-center text-lg/6 font-medium text-kumo-default">{greeting}</h1>
      <div className="mt-7 w-full">
        <Composer ref={composerRef} onPasteLinks={onPasteLinks} onSend={onSend} initialDraft={initialDraft} commands={commands} format={format} problem={problem} addActions={addActions} autoFocus={autoFocus} />
      </div>
      {below && <div className="mt-6 flex w-full justify-center">{below}</div>}
    </div>
    {after && <div className="row-start-3 flex w-full max-w-md flex-col pt-12">{after}</div>}
  </div>
)
