import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { standingApprovals, withApproval, type StandingApproval } from './standingApprovals'
import { messageOf } from './useAttempt'

export type StandingApprovalsState =
  | { status: 'loading' }
  | { status: 'ready'; approvals: StandingApproval[] }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * What one workspace approves without asking, and could (`standingApprovals`), with the way to
 * switch each. The workspace is opened for each thing asked of it and let go of after, so no stub
 * is held between them. The state is not reset when `workspaceId` changes, so give the calling
 * component a `key` of the id.
 */
export const useStandingApprovals = (workspaceId: string) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<StandingApprovalsState>({ status: 'loading' })
  // The ones being switched, by key.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([overseer.listPreApprovableActions(), overseer.listAutoApprovedActionKinds()]).then(
      ([catalog, rules]) => {
        if (!cancelled) setState({ status: 'ready', approvals: standingApprovals(catalog, rules) })
      },
      (error) => {
        if (cancelled) return
        // What was listed stays up when it could not be read again.
        setState((current) =>
          current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry: () => setAttempts((count) => count + 1) })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, attempts])

  const mark = (key: string, enabled: boolean) =>
    setState((current) => (current.status === 'ready' ? { status: 'ready', approvals: withApproval(current.approvals, key, enabled) } : current))

  /** Switches one, shown at once and undone if the server refuses. Rejects with why. */
  const setEnabled = async ({ key, gatekeeperId, actionKind }: StandingApproval, enabled: boolean) => {
    setPending((current) => new Set(current).add(key))
    mark(key, enabled)
    const overseer = api.openWorkspace(workspaceId)
    try {
      await (enabled ? overseer.setAutoApprovedActionKind(gatekeeperId, actionKind) : overseer.removeAutoApprovedActionKind(gatekeeperId, actionKind.tag))
    } catch (error) {
      mark(key, !enabled)
      throw error
    } finally {
      overseer[Symbol.dispose]()
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  return { state, pending, setEnabled }
}
