import { useState } from 'react'
import { Checkbox } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { usePending, type ActionResult } from './usePending'

/** Someone who has access only through the person whose access is taken away. */
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
   * What taking it would do, once the server has said: what is left to them (see
   * `RemovalOutcome`), and who has it only through them. Unknown while it is asked.
   */
  outcome?: { left: 'nothing' | 'use' | 'unchanged'; dependents: RemovalDependent[] }
  /** Why the server could not say what taking it would do, which leaves it untaken. */
  unknown?: string
  /** Of those who have it only through them, the ones to take it from too. */
  removing: ReadonlySet<string>
  onRemovingChange: (removing: Set<string>) => void
  /** Takes it away. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
  /** What they are taken off, where it is one gadget rather than the whole workspace. */
  gadget?: string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const said = (name: string, { left }: NonNullable<RemovalDialogProps['outcome']>, gadget: string | undefined) => {
  if (gadget) return left === 'unchanged' ? `Your own invitation goes. ${name} can still use ${gadget} some other way.` : `${name} will no longer be able to use ${gadget}.`
  if (left === 'nothing') return `${name} will lose access to this workspace and everything in it.`
  if (left === 'use') return `${name} will no longer edit this workspace, but can still use some of its gadgets through someone else’s invitation.`
  return `Your own invitation goes. ${name} still has access some other way.`
}

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const RemovalContent = ({ name, outcome, unknown, removing, onRemovingChange, onConfirm, gadget, pending, run }: Omit<RemovalDialogProps, 'open' | 'onOpenChange'> & {
  pending: boolean
  run: (action: () => ActionResult) => void
}) => {
  const [problem, setProblem] = useState<string>()
  const count = 1 + (outcome?.dependents.filter(({ id }) => removing.has(id)).length ?? 0)
  const toggle = (id: string, on: boolean) => {
    const next = new Set(removing)
    if (on) next.add(id)
    else next.delete(id)
    onRemovingChange(next)
  }
  const confirm = () => {
    setProblem(undefined)
    run(async () => {
      try {
        await onConfirm()
      } catch (error) {
        setProblem(messageOf(error))
      }
    })
  }

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Remove {name}?</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {outcome ? said(name, outcome, gadget) : unknown ? `Couldn’t check who this affects: ${unknown}` : 'Checking who this affects…'}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      {outcome && outcome.dependents.length > 0 && (
        <section aria-label={`People ${name} let in`} className="appears flex min-h-0 flex-col gap-3 overflow-y-auto px-6 pt-2 pb-1">
          <p className="text-sm leading-normal text-kumo-subtle">
            {outcome.dependents.length === 1 ? 'This person has access only because of them.' : 'These people have access only because of them.'}{' '}
            Tick anyone to remove as well; the rest keep what they have.
          </p>
          <div className="flex flex-col rounded-(--surface-radius) bg-kumo-tint p-1.5">
            {outcome.dependents.map((person) => (
              <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-base leading-snug hover:bg-kumo-contrast/4">
                <Checkbox
                  aria-label={`Remove ${person.name} too`}
                  checked={removing.has(person.id)}
                  disabled={pending}
                  onCheckedChange={(checked) => toggle(person.id, checked === true)}
                />
                <Avatar name={person.name} className="bg-kumo-base" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-kumo-default">{person.name}</span>
                  <span className="truncate text-sm text-kumo-subtle">Invited by {person.invitedBy}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title="Couldn’t remove them" description={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          {/* Not until the server has said what it would do. */}
          <Button variant="danger" disabled={pending || !outcome} onClick={confirm}>
            {pending ? 'Removing…' : count > 1 ? `Remove ${count} people` : 'Remove'}
          </Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Asks before taking someone's access away, having asked the server what that would do. Those who
 * have it only through them are listed to be taken off too, each kept unless ticked. Whoever shows
 * it puts it away once it is done; a failure stays in it, under why.
 */
export const RemovalDialog = ({ open, onOpenChange, ...removal }: RemovalDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being done.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <RemovalContent {...removal} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
