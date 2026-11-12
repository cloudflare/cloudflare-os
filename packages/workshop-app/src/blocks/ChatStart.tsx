import { Mascot } from '@/components/mascot/Mascot'
import { Composer, type ComposerProps } from './Composer'

export type ChatStartProps = {
  /** What the page says to whoever is starting, e.g. "Hello Ada, what should we do today?" */
  greeting: string
  onSend: ComposerProps['onSend']
  /** Why the first message did not go. */
  problem?: ComposerProps['problem']
  /** Put the cursor in the composer once it is shown. */
  autoFocus?: boolean
}

/** Somewhere to start from nothing: the mascot and a greeting over the composer, in the middle of the page. */
export const ChatStart = ({ greeting, onSend, problem, autoFocus }: ChatStartProps) => (
  <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-3">
    <div className="flex w-full max-w-md flex-col items-center">
      {/* Small on a page that is mostly empty, so it notices a pointer from well away. */}
      <Mascot emotion="idle" color="brand" interactive reach={4} className="w-12 -mt-12" />
      <h1 className="mt-5 text-center text-lg/6 font-medium text-kumo-default">{greeting}</h1>
      <div className="mt-7 w-full">
        <Composer onSend={onSend} problem={problem} autoFocus={autoFocus} />
      </div>
    </div>
  </div>
)
