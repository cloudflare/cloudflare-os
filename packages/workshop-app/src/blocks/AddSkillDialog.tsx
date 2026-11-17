import { useId, useState, type FormEvent } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { TextField } from '@/components/TextField'

/** A skill as it is written here: what it is called, what it is for, and what it is filed under, if anything. */
export type NewSkill = { name: string; description: string; tag?: string }

export type AddSkillDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The tags there are, which the field for one offers as it is typed in. */
  tags?: string[]
  /** Adds it, holding the dialog while it does, and leaving it open under why if it cannot. */
  onAdd: (skill: NewSkill) => void | Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// As long as a skill's name can be (the Agent Skills specification's limit).
const NAME_LENGTH = 64

const AddSkillForm = ({ tags = [], onAdd }: Pick<AddSkillDialogProps, 'tags' | 'onAdd'>) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const tagsId = useId()
  const written = name.trim() !== '' && description.trim() !== ''
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!written || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      await onAdd({ name: name.trim(), description: description.trim(), tag: tag.trim() || undefined })
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void add(event)} className="flex min-h-0 flex-col">
      <header className="flex items-center gap-3 p-6 pb-5">
        <Dialog.Title className="min-w-0 flex-1 text-lg font-medium text-kumo-default">Add skill</Dialog.Title>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        <TextField label="Name" autoFocus maxLength={NAME_LENGTH} placeholder="Summarize meeting notes" value={name} onValueChange={setName} />
        <TextField label="Description" rows={3} placeholder="What it’s for, and when the assistant should use it" value={description} onValueChange={setDescription} />
        <TextField label="Tag" list={tagsId} placeholder="Optional" value={tag} onValueChange={setTag} />
        <datalist id={tagsId}>
          {tags.map((known) => <option key={known} value={known} />)}
        </datalist>
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={`Couldn’t add it: ${problem}`} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={!written || pending}>{pending ? 'Adding…' : 'Add skill'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Where a skill is written, over the page: what it is called, what it is for, and a tag to file it
 * under, which is offered from those there are. It starts empty each time it is opened.
 */
export const AddSkillDialog = ({ open, onOpenChange, tags, onAdd }: AddSkillDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <AddSkillForm tags={tags} onAdd={onAdd} />
  </Dialog>
)
