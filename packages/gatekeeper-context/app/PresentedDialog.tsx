import { Dialog, type DialogProps } from '@gadgets/ui'
import { usePresentWhileOpen } from './bridge'

/**
 * The shared `Dialog`, over the whole Workshop rather than only the part of it this frame fills:
 * the host grows the frame to the window before it opens (`usePresentWhileOpen`), and shrinks it
 * back once it has gone.
 */
const PresentedDialogRoot = ({ open, onOpenChangeComplete, ...props }: DialogProps) => {
  const presentation = usePresentWhileOpen(open)
  return (
    <Dialog
      {...props}
      open={open && presentation.presenting}
      onOpenChangeComplete={(next) => {
        presentation.onOpenChangeComplete(next)
        onOpenChangeComplete?.(next)
      }}
    />
  )
}

export const PresentedDialog = Object.assign(PresentedDialogRoot, {
  Title: Dialog.Title,
  Description: Dialog.Description,
  Close: Dialog.Close,
})
