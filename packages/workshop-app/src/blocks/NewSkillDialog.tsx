import { useState } from 'react'
import { Input, InputArea } from '@cloudflare/kumo'
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { DropdownMenu } from '@/components/DropdownMenu'

/** A collection a new skill can be put in. */
export type SkillCollectionChoice = { id: string; title: string }

export type NewSkillDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where it can go, when there is more than one place; the first is where it goes unless chosen. */
  collections?: readonly SkillCollectionChoice[]
  /** The name the agent will know it by, from what is typed: `meeting-brief`. */
  nameOf: (title: string) => string
  /**
   * Makes it. Resolves to whether it was tried (`false` when the connection is down), and rejects
   * with why it was not made, which the dialog says under its fields.
   */
  onCreate: (skill: { collectionId?: string; title: string; description: string; instructions: string }) => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Writes a new skill: its name, when the agent should use it, and what it says. The name it will
 * be called by in a chat (`/meeting-brief`) shows under the name as it is typed. Where the user has
 * more than one collection to put it in, the place is chosen beside Create.
 */
export const NewSkillDialog = ({ open, onOpenChange, collections = [], nameOf, onCreate }: NewSkillDialogProps) => {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [collectionId, setCollectionId] = useState<string>()
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const into = collections.find(({ id }) => id === collectionId) ?? collections[0]
  const name = nameOf(title)
  const ready = name !== '' && description.trim() !== '' && instructions.trim() !== ''

  const create = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      if (await onCreate({ collectionId: into?.id, title: title.trim(), description: description.trim(), instructions })) onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => {
        setTitle('')
        setDescription('')
        setInstructions('')
        setCollectionId(undefined)
        setProblem(undefined)
      }}
      size="lg"
      title="New skill"
      description="Teach the agent how you like something done. It reads a skill when what you ask fits, or when you call it by name."
      footer={(
        <>
          {collections.length > 1 && into && (
            <DropdownMenu
              aria-label={`Put it in: ${into.title}`}
              triggerVariant="ghost"
              align="start"
              side="top"
              triggerClassName="me-auto px-3 text-kumo-subtle not-data-disabled:hover:text-kumo-default"
              disabled={pending}
              label={(
                <span className="flex items-center gap-1.5">
                  In {into.title}
                  <CaretDownIcon aria-hidden="true" weight="bold" className="size-3" />
                </span>
              )}
            >
              {collections.map((choice) => (
                <DropdownMenu.Item key={choice.id} label={choice.title} onSelect={() => setCollectionId(choice.id)}>
                  <span className="min-w-0 flex-1 truncate">{choice.title}</span>
                  {choice.id === into.id ? <CheckIcon aria-label="(chosen)" weight="bold" className="size-3.5 shrink-0" /> : <span aria-hidden="true" className="size-3.5 shrink-0" />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu>
          )}
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || !ready} onClick={() => void create()}>{pending ? 'Creating…' : 'Create'}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Input label="Name" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Meeting brief" disabled={pending} autoFocus />
          {/* Kept in its place while empty, so the fields under it do not move as it appears. */}
          <p aria-live="polite" className="min-h-5 px-1 text-sm/5 text-kumo-subtle">
            {name && <>Call it in a chat with <span className="font-medium text-kumo-default">/{name}</span></>}
          </p>
        </div>
        <InputArea
          label="When to use it"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Before a meeting, when I ask what I need to know"
          rows={2}
          disabled={pending}
        />
        <InputArea
          label="What it says"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={'What to gather, what to leave out, and the shape of the answer. Markdown works.'}
          rows={8}
          disabled={pending}
        />
      </div>
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
