import { useState, type FormEvent } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { TextField } from '@/components/TextField'

/**
 * A skill as it is written here: what it is called, what it is for, and the collection it goes
 * into: one there is (`collectionId`), or one made for it by its name (`tag`), or, with neither,
 * the user's first, My skills.
 */
export type NewSkill = { name: string; description: string; tag?: string; collectionId?: string }

/** One of the user's own collections, which a skill can be written into. */
export type SkillCollectionChoice = { id: string; title: string }

export type AddSkillDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The user's own collections, which it can go into, their first (My skills) first. */
  collections?: SkillCollectionChoice[]
  /** The collection it goes into, by its name, in place of a tag to file it under. */
  into?: string
  /** Adds it, holding the dialog while it does, and leaving it open under why if it cannot. */
  onAdd: (skill: NewSkill) => void | Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// As long as a skill's name can be (the Agent Skills specification's limit).
const NAME_LENGTH = 64

// The choice that stands for a collection made for it, by the name typed in its place.
const NEW = '\0new'

const AddSkillForm = ({ collections = [], into, onAdd }: Pick<AddSkillDialogProps, 'collections' | 'into' | 'onAdd'>) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // Their first, My skills, unless they have none yet, which the first skill makes.
  const [collection, setCollection] = useState(collections[0]?.id ?? '')
  const [newTitle, setNewTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const written = name.trim() !== '' && description.trim() !== '' && (collection !== NEW || newTitle.trim() !== '')
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!written || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      const place = collection === NEW ? { tag: newTitle.trim() } : collection ? { collectionId: collection } : {}
      await onAdd({ name: name.trim(), description: description.trim(), ...place })
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void add(event)} className="flex min-h-0 flex-col">
      <header className="flex items-center gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">Add skill</Dialog.Title>
          {into && <Dialog.Description className="text-sm wrap-anywhere text-kumo-subtle">To {into}</Dialog.Description>}
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        <TextField label="Name" autoFocus maxLength={NAME_LENGTH} placeholder="Summarize meeting notes" value={name} onValueChange={setName} />
        <TextField label="Description" rows={3} placeholder="What it’s for, and when the assistant should use it" value={description} onValueChange={setDescription} />
        {/* Written from a collection's page, it goes into that one, which the title says. */}
        {into === undefined && collections.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-kumo-default">Collection</span>
            <Select
              aria-label="Collection"
              value={collection}
              onValueChange={setCollection}
              options={[...collections.map(({ id, title }) => ({ id, label: title })), { id: NEW, label: 'New collection' }]}
              typed={collection === NEW ? { 'aria-label': 'New collection’s name', placeholder: 'Name it', autoFocus: true, value: newTitle, onValueChange: setNewTitle } : undefined}
            />
          </div>
        )}
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
 * Where a skill is written, over the page: what it is called, what it is for, and which of the
 * user's collections it goes into, My skills unless another is chosen, or a new one named there;
 * from a collection's page, that one. It starts empty each time it is opened.
 */
export const AddSkillDialog = ({ open, onOpenChange, collections, into, onAdd }: AddSkillDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <AddSkillForm collections={collections} into={into} onAdd={onAdd} />
  </Dialog>
)
