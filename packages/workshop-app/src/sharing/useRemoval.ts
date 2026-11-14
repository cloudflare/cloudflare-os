import { useState } from 'react'
import type { AiChatAuthorInfo, CollaboratorInfo } from '@gadgets/workshop-shared/api'
import type { RemovalDialogProps } from '@/blocks/RemovalDialog'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { invitedBy, type RemovalOutcome } from './sharingRules'
import type { SharingSession } from './SharingSession'

/**
 * Taking someone's access away from a sharing dialog: asks the server what that would do as the
 * question opens, and hands `RemovalDialog` the answer. Those who would lose access through them
 * are kept unless ticked. The person stays named while the dialog goes, after they have gone.
 */
export const useRemoval = ({ session, people, from, onRemoved }: {
  session: SharingSession
  /** Everyone whose name may be asked for: the owner, the viewer and those it is shared with. */
  people: readonly (AiChatAuthorInfo | CollaboratorInfo)[]
  from: RemovalDialogProps['from']
  onRemoved?: (name: string) => void
}) => {
  const connection = useConnectionNotice()
  const [target, setTarget] = useState<{ id: string; name: string }>()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<RemovalOutcome & { of: string }>()
  const [problem, setProblem] = useState<string>()
  const [removing, setRemoving] = useState<Set<string>>(new Set())

  const names = new Map(people.map((person) => 'profile' in person ? [person.profile.id, person.profile.name] : [person.id, person.name]))

  const ask = (person: { id: string; name: string }) => {
    if (connection?.blocked()) return
    setTarget(person)
    setOutcome(undefined)
    setProblem(undefined)
    setRemoving(new Set())
    setOpen(true)
    session.previewRemoval(person.id).then(
      (found) => setOutcome({ ...found, of: person.id }),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }

  const known = outcome && outcome.of === target?.id ? outcome : undefined
  const dialog: Omit<RemovalDialogProps, 'loss'> | undefined = target && {
    open,
    onOpenChange: setOpen,
    name: target.name,
    from,
    outcome: known && {
      losesAccess: known.losesAccess,
      dependents: known.dependents.map((person) => ({ id: person.profile.id, name: person.profile.name, invitedBy: invitedBy(person, names) })),
    },
    unknown: problem,
    removing,
    onRemovingChange: setRemoving,
    onConfirm: async () => {
      if (connection?.blocked()) throw new Error('Not connected. Try again once it’s back.')
      const keep = (known?.dependents ?? []).map(({ profile }) => profile.id).filter((id) => !removing.has(id))
      await session.remove(target.id, keep)
      onRemoved?.(target.name)
    },
  }

  return { ask, dialog }
}
