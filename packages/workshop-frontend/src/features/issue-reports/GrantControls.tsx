import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  type AuthenticatedApi,
  type IssueReportGrant,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { issueFailure } from './issueFailure'

const GRANT_HOURS = ADMIN_GRANT_LIFETIME_SECONDS / 3600

// A workspace as openWorkspace() promises it: calls are made on the promise, which stands for the
// workspace, and disposing it disposes the workspace's stub.
type Workspace = ReturnType<RpcStub<AuthenticatedApi>['openWorkspace']>

type Action = 'renew' | 'end' | 'give'

const FAILURES: Record<Action, string> = {
  renew: 'Couldn’t renew access.',
  end: 'Couldn’t end access.',
  give: 'Couldn’t give access.',
}

/**
 * A grant its giver follows: what it covers, until when or how it ended, and, while it is live,
 * Renew and End access. A grant that has ended can be given again where it came with a report and
 * the deployment still lets content be read; the grant then given takes the ended one's place on
 * the report.
 *
 * What is shown is a copy, the report's or the account's. End access is offered for as long as
 * the copy says live: ending a grant that has already ended changes nothing and is no error, and
 * it is how a copy that missed the end is put right.
 */
export const GrantControls = ({ grant, report, onChanged }: {
  grant: IssueReportGrant
  /**
   * The report the grant came with: `workspaceId` is where a grant of scope "workspace" is
   * stored, and `id` is what a grant given again is linked to. Absent for the account-wide grant
   * shown on its own.
   */
  report?: { id: string; workspaceId?: string }
  /** Reads again what shows the grant. Called after each change; it never rejects. */
  onChanged: () => Promise<void>
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const canGive = useServerConfig()?.adminContentGrants === true
  const [running, setRunning] = useState<Action | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const summary = useRef<HTMLParagraphElement>(null)
  const pressed = useRef<HTMLElement | null>(null)

  // A button is disabled while its call runs, which takes focus from it, and is gone if the call
  // changed what the grant offers. Focus goes back to the button, or to the line that says what
  // became of the grant, unless it has gone elsewhere since.
  useEffect(() => {
    if (running !== null || pressed.current === null) return
    if (document.activeElement === document.body) {
      (pressed.current.isConnected ? pressed.current : summary.current)?.focus()
    }
    pressed.current = null
  }, [running])

  const account = grant.scope === 'account'
  const workspaceId = report?.workspaceId
  const live = grant.endedAt === undefined && grant.expiresAt.getTime() > Date.now()

  // The call is sent on the promise of the workspace, so it leaves with the one that opens it.
  const onWorkspace = async (call: (workspace: Workspace) => Promise<unknown>) => {
    if (workspaceId === undefined) return
    const workspace = authenticatedApi.openWorkspace(workspaceId)
    try {
      await call(workspace)
    } finally {
      workspace[Symbol.dispose]()
    }
  }

  const calls: Record<Action, () => Promise<unknown>> = account ? {
    renew: () => authenticatedApi.grantAccountAdminAccess(),
    end: () => authenticatedApi.revokeAccountAdminAccess(),
    give: () => authenticatedApi.grantAccountAdminAccess({ reportId: report?.id }),
  } : {
    renew: () => onWorkspace((workspace) => workspace.renewAdminAccess(grant.id)),
    end: () => onWorkspace((workspace) => workspace.revokeAdminAccess(grant.id)),
    give: () => onWorkspace((workspace) => workspace.grantAdminAccess({ reportId: report?.id })),
  }

  const run = async (action: Action) => {
    if (running !== null) return
    pressed.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setRunning(action)
    setProblem(null)
    try {
      await calls[action]()
      await onChanged()
    } catch (err) {
      setProblem(issueFailure(err, FAILURES[action]))
    } finally {
      setRunning(null)
    }
  }

  // A grant of scope "workspace" is stored in the workspace its report names.
  const reachable = account || workspaceId !== undefined
  const content = account ? 'the content of all your workspaces' : 'this workspace’s content'

  return (
    <div className="space-y-2">
      <p ref={summary} tabIndex={-1} className="text-sm text-kumo-default focus:outline-none">
        <span className="font-medium">{account ? 'All my workspaces' : 'This workspace'}</span>
        {live ? (
          <>, until <time dateTime={grant.expiresAt.toISOString()}>{formatFullTimestamp(grant.expiresAt)}</time></>
        ) : grant.endedAt !== undefined ? (
          <>. Ended <time dateTime={grant.endedAt.toISOString()}>{formatFullTimestamp(grant.endedAt)}</time></>
        ) : '. Expired'}
      </p>
      {live && reachable && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={running === 'renew'}
              disabled={running !== null} onClick={() => void run('renew')}>
              Renew
            </Button>
            <Button variant="secondary-destructive" size="sm" loading={running === 'end'}
              disabled={running !== null} onClick={() => void run('end')}>
              End access
            </Button>
          </div>
          <p className="text-xs text-kumo-subtle">
            Renew gives admins {GRANT_HOURS} hours from now. End access ends this grant alone:
            admins can read nothing more under it
            {account ? ' within a minute.' : ' from their next call.'} Any other grant you gave
            stays until you end it too.
          </p>
        </>
      )}
      {/* Only a workspace's owner can have given a grant with the report, so a report that shows
          one is its owner's to give another. The server decides all the same. */}
      {!live && reachable && report !== undefined && canGive && (
        <>
          <div>
            <Button variant="secondary" size="sm" loading={running === 'give'} onClick={() => void run('give')}>
              Give access again
            </Button>
          </div>
          <p className="text-xs text-kumo-subtle">
            Lets admins read {content} for {GRANT_HOURS} hours. Everything an admin reads under a
            grant is recorded.
          </p>
        </>
      )}
      {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
    </div>
  )
}
