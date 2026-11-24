import { useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  getAdminAccessErrorCode,
  getAdminGrantErrorCode,
  type AdminApi,
  type AdminContentRequest,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'

// Names that differ only by the case of ASCII letters are one admin, as the deployment's list of
// admins matches them. The server decides: this only spares a requester an approval it refuses.
const asciiLowerCase = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

// The server's own message for a refusal it names by code, which says what the admin can do about
// it. Undefined for any other failure.
const adminRefusalMessage = (err: unknown): string | undefined => {
  const code = getAdminAccessErrorCode(err) ?? getAdminGrantErrorCode(err)
  return code !== undefined && err instanceof Error ? err.message : undefined
}

type Decision = 'approve' | 'deny'

/**
 * Approve and Deny for a pending request to read a workspace's content without its owner, in its
 * audit record's details. An admin other than the requester approves, so the signed-in admin's
 * own request offers only Withdraw, which denies it; with `userId` not yet known, or below the
 * Content level (`approvable` false), where the server refuses an approval, only Deny is offered,
 * so a request left from before the level was lowered can still be cleared. Each outcome is said in a toast, and `onDecided` is called once a decision settles,
 * whatever it said, so that the log loads again with the decision's record and without the
 * request as pending.
 */
export const RequestDecision = ({ admin, request, userId, approvable, onDecided }: {
  admin: RpcStub<AdminApi>
  request: AdminContentRequest
  /** The signed-in admin, by canonical user id, once confirmed. */
  userId: string | undefined
  /** Whether the level in force is Content, below which an approval is refused. */
  approvable: boolean
  onDecided: () => void
}) => {
  const toasts = useKumoToastManager()
  const [deciding, setDeciding] = useState<Decision | null>(null)
  // Set once a decision went through: its buttons stay disabled until the reload takes them away.
  const [decided, setDecided] = useState(false)
  const own = userId !== undefined && asciiLowerCase(request.requestedBy) === asciiLowerCase(userId)
  const title = request.workspaceTitle || 'Untitled'
  const denial = own ? 'Withdraw' : 'Deny'

  const decide = async (decision: Decision) => {
    setDeciding(decision)
    try {
      if (decision === 'approve') {
        const approved = await admin.approveContentAccess(request.id)
        toasts.add(approved.state === 'failed'
          ? {
            // "failed" also covers a reply lost after the workspace may have given the grant, so the
            // title rules nothing out and the server's error says which it was.
            title: `Approval not confirmed: ${title}`,
            description: approved.error ?? 'The workspace gave no grant.',
            variant: 'error',
          }
          : {
            title: `Approved: ${title}`,
            description: `Admins can read its content for ${ADMIN_GRANT_LIFETIME_SECONDS / 3600} hours.`,
            variant: 'success',
          })
      } else {
        await admin.denyContentAccess(request.id)
        toasts.add({ title: `${own ? 'Withdrawn' : 'Denied'}: ${title}`, variant: 'success' })
      }
      setDecided(true)
    } catch (err) {
      const refusal = adminRefusalMessage(err)
      if (refusal === undefined) logRpcFailure('Failed to decide a content access request:', err)
      toasts.add({
        title: `Couldn’t ${decision === 'approve' ? 'approve' : denial.toLowerCase()} the request`,
        description: refusal ?? rpcFailureDescription(err),
        variant: 'error',
      })
    } finally {
      setDeciding(null)
    }
    onDecided()
  }

  const busy = deciding !== null || decided
  return (
    <div className="mt-4 space-y-2 border-t border-kumo-line pt-3">
      <p className="text-sm text-kumo-subtle">
        {approvable
          ? own ? 'Your request is waiting for another admin to approve it' : 'Waiting for an admin to approve it'
          : 'Inspection access is below Content, so it can’t be approved. It can be denied'},
        until <time dateTime={request.expiresAt.toISOString()}>{formatFullTimestamp(request.expiresAt)}</time>.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {approvable && !own && userId !== undefined && (
          <Button
            variant="primary"
            size="sm"
            loading={deciding === 'approve'}
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            Approve
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={deciding === 'deny'}
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          {denial}
        </Button>
      </div>
    </div>
  )
}
