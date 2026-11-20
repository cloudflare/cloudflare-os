import { useState } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Banner, Button, Dialog } from '@gadgets/ui'
import { usePending, type ActionResult } from './usePending'
import type { WorkspaceRemoval } from './WorkspaceMoreMenu'

export type RemoveWorkspaceDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The workspace's title. */
  title: string
  /** Whether it is deleted, as its owner's, or removed from the viewer's list, as shared with them. */
  removal: WorkspaceRemoval
  /**
   * How many people besides the viewer have access to it, once that is known, for what deleting it
   * takes from whom.
   */
  others?: number
  /** Deletes or removes it. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const fromWhom = (others: number | undefined) => {
  if (others === undefined) return ', for you and everyone it’s shared with'
  if (others === 0) return ''
  return others === 1 ? ', for you and the one person it’s shared with' : `, for you and the ${others} people it’s shared with`
}

/** What each removal asks, says it does, and calls its confirm button. */
export const REMOVAL_WORDS: Record<WorkspaceRemoval, {
  question: (title: string) => string
  said: (others: number | undefined) => string
  confirm: string
  variant: 'danger' | 'primary'
  pending: string
  problem: string
}> = {
  delete: {
    question: (title: string) => `Delete “${title}”?`,
    said: (others: number | undefined) =>
      `Its chats, everything made in it and anything set to run there are deleted${fromWhom(others)}. This can’t be undone.`,
    confirm: 'Delete workspace',
    // What cannot be taken back.
    variant: 'danger',
    pending: 'Deleting…',
    problem: 'Couldn’t delete the workspace',
  },
  dismiss: {
    question: (title: string) => `Remove “${title}” from your list?`,
    said: () => 'It stays as it is for everyone else, and you keep your access: open it again from its link and it’s back in your list.',
    confirm: 'Remove',
    // Opening it again takes it back, so it is not drawn as what cannot be.
    variant: 'primary',
    pending: 'Removing…',
    problem: 'Couldn’t remove the workspace',
  },
}

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const RemoveWorkspaceContent = ({ title, removal, others, onConfirm, pending, run }: Omit<RemoveWorkspaceDialogProps, 'open' | 'onOpenChange'> & {
  pending: boolean
  run: (action: () => ActionResult) => void
}) => {
  const [problem, setProblem] = useState<string>()
  const words = REMOVAL_WORDS[removal]
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
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{words.question(title || 'Untitled workspace')}</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">{words.said(others)}</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title={words.problem} description={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant={words.variant} disabled={pending} onClick={confirm}>{pending ? words.pending : words.confirm}</Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Asks before a workspace goes from the viewer's list, saying what that does: deleting it, as its
 * owner, takes everything in it from everyone who has it, for good; removing one shared with them
 * only takes it off their list, and opening it again brings it back. Whoever shows it puts it away
 * once it is done; a failure stays in it, under why.
 */
export const RemoveWorkspaceDialog = ({ open, onOpenChange, ...removal }: RemoveWorkspaceDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being done.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <RemoveWorkspaceContent {...removal} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
