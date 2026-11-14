import { useEffect, useState } from 'react'
import { ArrowBendUpLeftIcon, ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CheckIcon, ClockCounterClockwiseIcon, CopyIcon, InfoIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { usePending, type ActionResult } from './usePending'

export type MessageActionsProps = {
  /** Start a reply to the message. */
  onReply?: () => void
  /** What copying the message puts on the clipboard. Without it there is nothing to copy, and no button. */
  copyText?: string
  /** The message's details can be shown under it: whether they are, and the way to switch. */
  details?: { open: boolean; onToggle: () => void; controls?: string }
  /** The changes its turn kept can be gone back on from here (see `GO_BACK`). */
  goBack?: { action: keyof typeof GO_BACK; onSelect: () => ActionResult }
}

/** Going back on kept changes: undoing the newest, redoing an undo, or returning to an older point. */
export const GO_BACK = {
  undo: { icon: ArrowCounterClockwiseIcon, label: 'Undo these changes' },
  redo: { icon: ArrowClockwiseIcon, label: 'Redo these changes' },
  restore: { icon: ClockCounterClockwiseIcon, label: 'Go back to how things were here' },
}

/** Compact, fill-free actions beside a message or its details panel. */
export const MESSAGE_ACTION_STYLE = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

/** How long the copy button shows how the copying went. */
const COPY_SHOWN_FOR = 1500

const COPY = {
  ready: { icon: CopyIcon, label: 'Copy' },
  copied: { icon: CheckIcon, label: 'Copied' },
  failed: { icon: XIcon, label: 'Couldn’t copy' },
}

/** What can be done with a message: reply to it, copy it, go back on its changes, see more about it. */
export const MessageActions = ({ onReply, copyText, details, goBack }: MessageActionsProps) => {
  const [goingBack, runGoBack] = usePending()
  // How the last copy went, shown in place of the copy icon for a moment.
  const [copy, setCopy] = useState<keyof typeof COPY>('ready')
  useEffect(() => {
    if (copy === 'ready') return
    const timer = setTimeout(() => setCopy('ready'), COPY_SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [copy])
  // The clipboard is refused without permission and is not there at all on a page that is not
  // served securely: either way the copy failed.
  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <div className="flex items-center">
      <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={MESSAGE_ACTION_STYLE} onClick={onReply} />
      {copyText !== undefined && (
        <Button
          variant="ghost"
          icon={COPY[copy].icon}
          aria-label={COPY[copy].label}
          title={COPY[copy].label}
          className={MESSAGE_ACTION_STYLE}
          onClick={() => void copyMessage(copyText)}
        />
      )}
      {goBack && (
        <Button
          variant="ghost"
          icon={GO_BACK[goBack.action].icon}
          aria-label={GO_BACK[goBack.action].label}
          title={GO_BACK[goBack.action].label}
          disabled={goingBack}
          className={MESSAGE_ACTION_STYLE}
          onClick={() => runGoBack(goBack.onSelect)}
        />
      )}
      <Button
        variant="ghost"
        icon={InfoIcon}
        aria-label="Details"
        title="Details"
        aria-expanded={details?.open}
        aria-controls={details?.controls}
        className={MESSAGE_ACTION_STYLE}
        onClick={details?.onToggle}
      />
    </div>
  )
}
