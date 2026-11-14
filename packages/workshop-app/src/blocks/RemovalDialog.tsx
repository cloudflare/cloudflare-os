import { useState } from 'react'
import { Checkbox } from '@cloudflare/kumo'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'

export type RemovalDependent = {
  id: string
  name: string
  /** Who let them in: "Grace Hopper", "A link". */
  invitedBy: string
}

export type RemovalDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whose access is being taken away. */
  name: string
  /**
   * What taking it would do, once the server has said: whether they lose it (otherwise they still
   * have it some other way), and who has it only through them. Unknown while it is asked.
   */
  outcome?: { losesAccess: boolean; dependents: RemovalDependent[] }
  /** Why the server could not say what taking it would do, which leaves it untaken. */
  unknown?: string
  /** What it is taken from, which says what they lose. */
  from: 'workspace' | 'chat' | 'gadget'
  /** What losing it does to them, in place of the plain sentence, such as that it disconnects them. */
  loss?: string
  /** Of those who have it only through them, the ones to take it from too. */
  removing: ReadonlySet<string>
  onRemovingChange: (removing: Set<string>) => void
  /** Takes it away. A rejection leaves the dialog open, under why. */
  onConfirm: () => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Asks before taking someone's access away, having asked the server what that would do. Those who
 * have it only through them are listed to be taken off too, each kept unless ticked.
 */
export const RemovalDialog = ({ open, onOpenChange, name, outcome, unknown, from, loss, removing, onRemovingChange, onConfirm }: RemovalDialogProps) => {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const count = 1 + (outcome?.dependents.filter(({ id }) => removing.has(id)).length ?? 0)
  const run = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }
  const toggle = (id: string, on: boolean) => {
    const next = new Set(removing)
    if (on) next.add(id)
    else next.delete(id)
    onRemovingChange(next)
  }

  const description = !outcome
    ? unknown ? `Couldn’t check who this affects: ${unknown}` : 'Checking who this affects…'
    : !outcome.losesAccess
      ? `Your own invitation goes. ${name} may still have access some other way.`
      : loss ?? (from === 'workspace'
        ? `${name} will lose access to this workspace and everything in it, including gadgets shared with them on their own.`
        : from === 'chat'
          ? `${name} will lose access to this chat and everything it made, including gadgets shared with them on their own.`
          : `${name} will lose access to this gadget.`)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => setProblem(undefined)}
      size="sm"
      title={`Remove ${name}?`}
      description={description}
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" disabled={pending || !outcome} onClick={() => void run()}>
            {pending ? 'Removing…' : count > 1 ? `Remove ${count} people` : 'Remove'}
          </Button>
        </>
      )}
    >
      {outcome && outcome.dependents.length > 0 && (
        <section aria-label={`People ${name} let in`} className="appears flex flex-col gap-2">
          <p className="text-sm/5 text-kumo-subtle">
            {outcome.dependents.length === 1 ? 'This person has access only because of them.' : 'These people have access only because of them.'}{' '}
            Tick anyone to remove as well; the rest keep what they have.
          </p>
          <div className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
            {outcome.dependents.map((person) => (
              <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-2xl px-2.5 py-2 text-base/5 hover:bg-kumo-contrast/4">
                <Checkbox
                  aria-label={`Remove ${person.name} too`}
                  checked={removing.has(person.id)}
                  disabled={pending}
                  onCheckedChange={(checked) => toggle(person.id, checked === true)}
                />
                <Avatar name={person.name} />
                <span className="flex w-0 min-w-0 flex-1 flex-col">
                  <span className="truncate text-kumo-default">{person.name}</span>
                  <span className="truncate text-sm text-kumo-subtle">Invited by {person.invitedBy}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
