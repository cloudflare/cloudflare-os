import { WorkshopButton } from '../../components/WorkshopControls'
import { NewSpaceDialog } from './NewSpaceDialog'
import { useNewSpaceDialog } from './useNewSpaceDialog'
import type { Spaces } from './useSpaces'

/** The entry point to creating a team space: a button that opens `NewSpaceDialog`. */
export const NewSpaceButton = ({ className, spaces, onCreated }: {
  className?: string
  /** The user's spaces (`useSpaces`), which the dialog is given. */
  spaces: Spaces
  /** A space with this id now exists, with the user as its first admin. */
  onCreated: (id: string) => void
}) => {
  const dialog = useNewSpaceDialog()

  return (
    <>
      <WorkshopButton ref={dialog.buttonRef} className={className} onClick={dialog.show}>
        New space
      </WorkshopButton>
      {dialog.open && (
        <NewSpaceDialog
          spaces={spaces}
          onClose={dialog.dismiss}
          onCreated={(id) => {
            dialog.close()
            onCreated(id)
          }}
        />
      )}
    </>
  )
}
