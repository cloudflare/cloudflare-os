import { Button, Dialog } from '@gadgets/ui'

export type CodeFileCautionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What is about to be done to the file. */
  action: 'rename' | 'delete'
  /** The file's name. */
  name: string
  /** Why it is worth a second thought: what stops working. */
  caution: string
  /** Goes on with it. */
  onConfirm: () => void
}

/**
 * Asks before renaming or deleting a file the gadget is built from, which would stop it working:
 * said in a sentence, with the way on and the way out, rather than as a note on the menu's item.
 * Whoever shows it goes on with the action when it is confirmed.
 */
export const CodeFileCautionDialog = ({ open, onOpenChange, action, name, caution, onConfirm }: CodeFileCautionDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <header className="flex flex-col gap-1 p-6 pb-2 leading-snug">
      <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">
        {action === 'rename' ? 'Rename' : 'Delete'} “{name}”?
      </Dialog.Title>
      <Dialog.Description className="text-sm text-kumo-subtle">{caution}</Dialog.Description>
    </header>
    <footer className="flex justify-end gap-2 p-6 pt-4">
      <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
      <Button
        variant={action === 'delete' ? 'danger' : 'primary'}
        onClick={() => {
          onOpenChange(false)
          onConfirm()
        }}
      >
        {action === 'rename' ? 'Rename' : 'Delete'}
      </Button>
    </footer>
  </Dialog>
)
