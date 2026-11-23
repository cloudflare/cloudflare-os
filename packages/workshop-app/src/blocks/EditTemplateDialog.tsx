import { useState, type FormEvent } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { Banner, Button, Dialog, TextField } from '@gadgets/ui'

type Fields = { title: string; description: string }

export type EditTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is called and what it is for now. */
  template: Fields
  /** Keeps what was typed, rejecting with why it could not. */
  onSave: (fields: Fields) => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the dialog holds while it is open, which starts over each time it is opened.
const EditTemplateContent = ({ template, onSave, onOpenChange }: Omit<EditTemplateDialogProps, 'open'>) => {
  const [title, setTitle] = useState(template.title)
  const [description, setDescription] = useState(template.description)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || title.trim() === '') return
    setProblem(undefined)
    setPending(true)
    try {
      await onSave({ title: title.trim(), description: description.trim() })
      onOpenChange(false)
    } catch (error) {
      setProblem(`Couldn’t save it: ${messageOf(error)}`)
      setPending(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-col">
      <header className="flex items-start gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Edit template</Dialog.Title>
          <Dialog.Description className="text-sm text-pretty text-kumo-subtle">What people see of it on its page. Its code stays as it is: releasing an update is separate.</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        <TextField label="Title" autoFocus value={title} onValueChange={setTitle} />
        <TextField label="What it’s for" rows={3} placeholder="Optional. Shown on the template’s page" value={description} onValueChange={setDescription} />
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={pending || title.trim() === ''}>{pending ? 'Saving…' : 'Save'}</Button>
        </div>
      </footer>
    </form>
  )
}

/** Changing what a template made by the viewer is called, and what it is for, over the page. */
export const EditTemplateDialog = ({ open, onOpenChange, ...props }: EditTemplateDialogProps) => (
  <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
    <EditTemplateContent {...props} onOpenChange={onOpenChange} />
  </Dialog>
)
