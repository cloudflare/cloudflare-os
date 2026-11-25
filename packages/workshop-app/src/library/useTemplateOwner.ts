import { useState } from 'react'
import type { BlueprintUnpublishedChanges } from '@gadgets/workshop-shared/api'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { templateStore } from './useTemplates'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What the viewer does to a template they made, from the workspace it was made in: releasing what
 * its gadget has changed since (its code as the next version, or only its connections), and
 * deleting it. Each runs one at a time and not over a lost connection; one that fails says why in
 * `problem`. A successful mutation calls `onChange` with its id, and a deletion also calls
 * `onRemoved`. Given no workspace, as for one whose workspace is gone, nothing can be done.
 */
export const useTemplateOwner = (workspaceId: string | undefined, { onChange, onRemoved }: { onChange?: (id: string) => void; onRemoved?: () => void } = {}) => {
  const connection = useConnectionNotice()
  // The template being worked on, and why the last could not be.
  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const run = (id: string, what: string, act: (workspace: string) => Promise<void>) => {
    if (busy !== undefined || workspaceId === undefined) return
    setProblem(undefined)
    if (connection?.blocked()) return
    setBusy(id)
    act(workspaceId).then(
      () => {
        setBusy(undefined)
        onChange?.(id)
      },
      (error: unknown) => {
        setBusy(undefined)
        setProblem(`Couldn’t ${what}: ${messageOf(error)}`)
      },
    )
  }

  return {
    busy,
    problem,
    release: (id: string, changes: BlueprintUnpublishedChanges) => run(id, 'update the template', (workspace) => templateStore.release(workspace, id, changes)),
    /** Keeps a new title and what it is for; rejects with why it could not, for the dialog that asked to say. */
    edit: async (id: string, fields: { title: string; description: string }) => {
      if (workspaceId === undefined) throw new Error('Its workspace is gone.')
      if (connection?.blocked()) throw new Error('The Workshop is reconnecting.')
      await templateStore.update(workspaceId, id, fields)
      onChange?.(id)
    },
    remove: (id: string) => run(id, 'delete the template', async (workspace) => {
      await templateStore.remove(workspace, id)
      onRemoved?.()
    }),
  }
}
