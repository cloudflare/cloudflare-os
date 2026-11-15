import { useState, type FormEvent } from 'react'
import { Button, Dialog, Input } from '@cloudflare/kumo'
import { MAX_ADMIN_ACCESS_REASON_LENGTH, type AdminAccessGrant } from '@gadgets/workshop-shared/api'
import { adminRefusalMessage } from '../../features/admin-writes/writeLabels'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'

/**
 * Asks why a grant a second admin approved is being ended, and ends it. It is open while `grant`
 * is set. The reason field comes first in it, so that it is what takes focus when it opens.
 */
export const EndGrantDialog = ({ grant, onEnd, onClose, onClosed }: {
  /** The grant to end, null while the dialog is closed. */
  grant: AdminAccessGrant | null
  /** Ends `grant` for the reason given, and settles once the page shows what that left. */
  onEnd: (grant: AdminAccessGrant, reason: string) => Promise<void>
  onClose: () => void
  /** Called once the dialog has closed, while focus is still in it. */
  onClosed: () => void
}) => {
  const [reason, setReason] = useState('')
  const [ending, setEnding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const trimmed = reason.trim()

  const close = () => {
    setReason('')
    setProblem(null)
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (grant === null || trimmed === '' || ending) return
    setEnding(true)
    setProblem(null)
    try {
      await onEnd(grant, trimmed)
      close()
    } catch (err) {
      const refusal = adminRefusalMessage(err)
      if (refusal === undefined) logRpcFailure('Failed to end the grant:', err)
      setProblem(refusal ?? rpcFailureDescription(err) ?? 'Couldn’t end the access.')
    } finally {
      setEnding(false)
    }
  }

  return (
    <Dialog.Root
      open={grant !== null}
      onOpenChange={(open) => { if (!open && !ending) close() }}
      onOpenChangeComplete={(open) => { if (!open) onClosed() }}
    >
      <Dialog size="lg" className="p-6">
        <form noValidate onSubmit={submit} className="grid gap-4">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-kumo-strong">End this access?</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              Admins stop reading this workspace’s content under this grant with their next call.
              The ending is recorded in the audit log with your name and your reason.
            </Dialog.Description>
          </div>
          <Input
            label="Why are you ending this access?"
            autoComplete="off"
            maxLength={MAX_ADMIN_ACCESS_REASON_LENGTH}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={ending} onClick={close}>Cancel</Button>
            <Button type="submit" variant="destructive" loading={ending} disabled={trimmed === ''}>
              End access
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
