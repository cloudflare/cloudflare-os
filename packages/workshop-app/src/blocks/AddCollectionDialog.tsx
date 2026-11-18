import { useState, type FormEvent } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { TextField } from '@/components/TextField'

/** A collection as it is made here: what it is called, and what is in it, if that is said. */
export type NewCollection = { title: string; description: string }

export type AddCollectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Makes it, holding the dialog while it does, and leaving it open under why if it cannot. */
  onAdd: (collection: NewCollection) => void | Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const AddCollectionForm = ({ onAdd }: Pick<AddCollectionDialogProps, 'onAdd'>) => {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const written = title.trim() !== ''
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!written || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      await onAdd({ title: title.trim(), description: description.trim() })
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void add(event)} className="flex min-h-0 flex-col">
      <header className="flex items-start gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">New collection</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">Skills kept together, to share with people as one.</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        <TextField label="Name" autoFocus placeholder="Design team" value={title} onValueChange={setTitle} />
        <TextField label="Description" rows={3} placeholder="Optional" value={description} onValueChange={setDescription} />
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={`Couldn’t make it: ${problem}`} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={!written || pending}>{pending ? 'Making…' : 'Make collection'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Where a collection of skills is made, over the page: what it is called, and what it is for. It
 * starts empty each time it is opened.
 */
export const AddCollectionDialog = ({ open, onOpenChange, onAdd }: AddCollectionDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <AddCollectionForm onAdd={onAdd} />
  </Dialog>
)
