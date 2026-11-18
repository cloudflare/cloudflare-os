import { useState } from 'react'
import { DeleteGadgetDialog } from '@/blocks/DeleteGadgetDialog'
import type { PaneStatusProps } from '@/blocks/PaneStatus'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { titleAfter, type Renamed } from './gadgetChanges'
import { useGadgetChanges } from './useGadgetChanges'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Renaming and deleting the gadget shown in the pane, for whoever may change it (`may`): the title
 * to show, which is the new one from when it is typed until the gadget says it, put back if that
 * was refused; the ways to ask for each, the second of which asks first (`dialog`), and is offered
 * only where there is somewhere to go once it is gone (`onDeleted`); and why a rename was refused
 * (`status`). Nothing is asked over a lost connection, which says so itself.
 */
export const useGadgetEdits = (
  gadget: { workspaceId: string; workpieceId: number } | undefined,
  /** Its title as it is read. */
  read: string,
  { may, workspace, onDeleted }: { may: boolean; workspace?: string; onDeleted?: () => void },
) => {
  const changes = useGadgetChanges()
  const connection = useConnectionNotice()
  const key = gadget && `${gadget.workspaceId}/${gadget.workpieceId}`
  const [renamed, setRenamed] = useState<Renamed & { key: string }>()
  const [refused, setRefused] = useState<{ key: string; message: string }>()
  // Kept as the dialog closes, so that it does not change as it goes.
  const [deleting, setDeleting] = useState<{ key: string; title: string; open: boolean }>()
  const title = titleAfter(read, renamed?.key === key ? renamed : undefined)

  const rename = (next: string) => {
    if (!gadget || !key || connection?.blocked()) return
    const edit = { key, from: read, to: next }
    setRenamed(edit)
    setRefused(undefined)
    changes.rename(gadget, next).catch((error: unknown) => {
      setRenamed((current) => (current === edit ? undefined : current))
      setRefused({ key, message: messageOf(error) })
    })
  }

  const status: PaneStatusProps | undefined = refused && refused.key === key
    ? { tone: 'failed', title: 'Couldn’t rename it', description: refused.message, onDismiss: () => setRefused(undefined) }
    : undefined

  const dialog = gadget && deleting && deleting.key === key && (
    <DeleteGadgetDialog
      key={deleting.key}
      open={deleting.open}
      onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
      title={deleting.title}
      workspace={workspace}
      onConfirm={async () => {
        if (connection?.blocked()) return
        await changes.remove(gadget)
        setDeleting({ ...deleting, open: false })
        onDeleted?.()
      }}
    />
  )

  return {
    title,
    onRename: gadget && may ? rename : undefined,
    onDelete: gadget && key && may && onDeleted ? () => setDeleting({ key, title, open: true }) : undefined,
    status,
    dialog,
  }
}
