import { useEffect, useRef, useState } from 'react'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { messageOf } from '../../useAttempt'
import type { AdminCapability } from '../AdminContext'
import { probeRouterTag } from './probeRouterTag'

export type UpdateStatusState =
  | { status: 'loading' }
  | { status: 'ready'; update: DeploymentUpdateStatus }
  // Not installed by the deploy flow, so not updated from here.
  | { status: 'absent' }
  | { status: 'failed'; message: string; retry: () => void }

const shown = (update: DeploymentUpdateStatus | null): UpdateStatusState => (update ? { status: 'ready', update } : { status: 'absent' })

/**
 * Which release the deployment runs and whether there is a newer one (`AdminApi.getUpdateStatus()`),
 * read over `admin` once the router's tag is recorded (`probeRouterTag`), with the way to read it
 * again. Only the latest read is shown, and what was shown stays up over one that fails.
 */
export const useUpdateStatus = (admin: AdminCapability | null) => {
  const [state, setState] = useState<UpdateStatusState>({ status: 'loading' })
  const [attempts, setAttempts] = useState(0)
  const reads = useRef(0)

  useEffect(() => {
    if (!admin) return
    let cancelled = false
    const read = ++reads.current
    probeRouterTag().then(() => admin.getUpdateStatus()).then(
      (update) => {
        if (!cancelled && read === reads.current) setState(shown(update))
      },
      (error) => {
        if (cancelled || read !== reads.current) return
        setState((current) => current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry: () => setAttempts((count) => count + 1) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [admin, attempts])

  /**
   * Shows `update`, what a call that answers with the status (a check) gave, or else reads the
   * status again. Resolves once it is shown; rejects where it could not be read.
   */
  const reload = async (update?: DeploymentUpdateStatus | null) => {
    if (!admin) return
    const read = ++reads.current
    const next = update === undefined ? await admin.getUpdateStatus() : update
    if (read === reads.current) setState(shown(next))
  }

  return { state, reload }
}
