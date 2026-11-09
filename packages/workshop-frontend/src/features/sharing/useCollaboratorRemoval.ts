import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AffectedCollaborator, CollaboratorInfo, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'

type Removal = {
  profileId: string
  dependents: AffectedCollaborator[]
  previewing: boolean
  /** Downstream people to keep; everyone is kept unless explicitly selected for removal. */
  keepSet: Set<string>
}

type Options = {
  overseer: RpcStub<Overseer>
  open: boolean
  collaborators: CollaboratorInfo[]
  /** Remove only the grants of this gadget, rather than the person's access to the workspace. */
  gadgetId?: WorkpieceId
  /** Called after a removal succeeds, to refresh the member list. */
  onRemoved: () => Promise<void>
}

/** Previews, then confirms, removing one collaborator and anyone whose access depends on them. */
export const useCollaboratorRemoval = ({ overseer, open, collaborators, gadgetId, onRemoved }: Options) => {
  const toasts = useKumoToastManager()
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setRemoval(null)
  }, [open])

  const start = async (profileId: string) => {
    setRemoval({ profileId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId, gadgetId)
      setRemoval(current => current?.profileId === profileId ? {
        ...current,
        dependents,
        previewing: false,
        keepSet: new Set(dependents.filter(person => person.profile.id !== profileId).map(person => person.profile.id)),
      } : current)
    } catch (err: any) {
      setRemoval(current => current?.profileId === profileId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview collaborator removal.', variant: 'error' })
    }
  }

  const confirm = async () => {
    if (!removal || removal.previewing || busy) return
    setBusy(true)
    try {
      const removed = await overseer.removeCollaborator(removal.profileId, [...removal.keepSet], gadgetId)
      await onRemoved()
      setRemoval(null)
      toasts.add({
        title: removed.length === 0
          ? 'Your direct grant was removed. This collaborator still has access through another source.'
          : gadgetId === undefined ? 'Collaborator removed.' : 'Removed their access to this gadget.',
        variant: 'success',
      })
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const view = removal && {
    profileId: removal.profileId,
    name: collaborators.find(info => info.profile.id === removal.profileId)?.profile.name ?? 'this person',
    previewing: removal.previewing,
    // The preview lists the target only if what this dialog grants would actually be taken away;
    // otherwise they keep it through another source.
    losesAccess: removal.dependents.some(dep => dep.profile.id === removal.profileId),
    downstream: removal.dependents.filter(dep => dep.profile.id !== removal.profileId),
    keepSet: removal.keepSet,
  }

  return {
    target: view,
    busy,
    start,
    confirm,
    cancel: () => setRemoval(null),
    setKeepSet: (keepSet: Set<string>) => setRemoval(current => current && { ...current, keepSet }),
  }
}
