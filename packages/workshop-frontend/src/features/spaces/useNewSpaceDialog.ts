import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'

/**
 * Whether a `NewSpaceDialog` is open, for whoever renders it, and where the focus goes once it
 * is dismissed. The dialog cannot hand the focus back itself: its name field takes the focus
 * as it mounts, before the dialog has noted what had it, and is gone by the time the dialog
 * closes. So the button the dialog is opened from takes it: whichever element `buttonRef`
 * holds then, since a list that was read again under the dialog has rendered the button anew.
 * `onFocusLost` is called after that, for a caller whose button may not be on the page at all.
 */
export const useNewSpaceDialog = (onFocusLost?: () => void): {
  /** Whether the dialog is to be rendered. */
  open: boolean
  /** For the button that opens the dialog. */
  buttonRef: RefObject<HTMLButtonElement | null>
  /** Opens the dialog. */
  show: () => void
  /** The dialog was closed with no space created: the button takes the focus back. */
  dismiss: () => void
  /** The dialog created a space. It closes, and the focus is the caller's, who goes to the space. */
  close: () => void
} => {
  // `dismissed` is `closed` reached without creating a space, which hands focus back to the button.
  const [dialog, setDialog] = useState<'closed' | 'open' | 'dismissed'>('closed')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const focusLost = useEffectEvent(() => onFocusLost?.())

  // Queued, so that it follows the dialog's own attempt rather than being undone by it.
  useEffect(() => {
    if (dialog !== 'dismissed') return
    queueMicrotask(() => {
      buttonRef.current?.focus()
      focusLost()
    })
  }, [dialog])

  return {
    open: dialog === 'open',
    buttonRef,
    show: () => setDialog('open'),
    dismiss: () => setDialog('dismissed'),
    close: () => setDialog('closed'),
  }
}
