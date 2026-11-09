import { useEffect, useRef, useState } from 'react'
import { WorkshopButton } from '../../components/WorkshopControls'
import { NewSpaceDialog } from './NewSpaceDialog'
import type { Spaces } from './useSpaces'

/** The entry point to creating a team space: a button that opens `NewSpaceDialog`. */
export const NewSpaceButton = ({ className, spaces, onCreated }: {
  className?: string
  /** The user's spaces (`useSpaces`), which the dialog is given. */
  spaces: Spaces
  /** A space with this id now exists, with the user as its first admin. */
  onCreated: (id: string) => void
}) => {
  // `dismissed` is `closed` reached without creating a space, which hands focus back to the button.
  const [dialog, setDialog] = useState<'closed' | 'open' | 'dismissed'>('closed')
  const buttonRef = useRef<HTMLButtonElement>(null)

  // The dialog cannot hand focus back itself: its name field takes focus as it mounts, before
  // the dialog has noted what had focus, and is gone by the time the dialog closes. Queued, so
  // that it follows the dialog's own attempt rather than being undone by it.
  useEffect(() => {
    if (dialog === 'dismissed') queueMicrotask(() => buttonRef.current?.focus())
  }, [dialog])

  return (
    <>
      <WorkshopButton ref={buttonRef} className={className} onClick={() => setDialog('open')}>
        New space
      </WorkshopButton>
      {dialog === 'open' && (
        <NewSpaceDialog
          spaces={spaces}
          onClose={() => setDialog('dismissed')}
          onCreated={(id) => {
            setDialog('closed')
            onCreated(id)
          }}
        />
      )}
    </>
  )
}
