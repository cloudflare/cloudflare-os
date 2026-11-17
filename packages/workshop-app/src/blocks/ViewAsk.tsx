import { ArrowUpIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type ViewAskProps = {
  /** What the view asked the viewer to send. */
  message: string
  /** The view that asked, by name. */
  from: string
  /** It is going. */
  sending?: boolean
  onSend: () => void
  onDismiss: () => void
}

/**
 * What a live view in an answer asked the viewer to send, after the answer, where their next
 * message would go: drawn as their own message will look, in outline until it is theirs, with
 * Send and Dismiss under it.
 */
export const ViewAsk = ({ message, from, sending = false, onSend, onDismiss }: ViewAskProps) => (
  <div role="group" aria-label={`${from} asks you to send this`} className="arrives flex origin-top-right flex-col items-end gap-2">
    <p className="max-w-[min(70%,65ch)] rounded-[21px] border border-dashed border-kumo-contrast/30 px-5 py-[11px] text-base/5 break-words whitespace-pre-wrap text-kumo-default">
      {message}
    </p>
    <div className="flex gap-2">
      <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
      <Button variant="primary" icon={ArrowUpIcon} disabled={sending} onClick={onSend}>Send</Button>
    </div>
  </div>
)
