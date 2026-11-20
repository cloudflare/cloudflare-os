import { useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Button, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  MAX_ADMIN_ACCESS_REASON_LENGTH,
  type AdminApi,
  type AdminContentRequest,
  type AdminWorkspaceAccess,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { useFocusAfterOperation } from './useFocusAfterOperation'
import { adminRefusalMessage, GRANT_HOURS, PENDING_APPROVALS_ID } from './grantLabels'

/** Where reading the deployment's admin access level stands, which only this form needs. */
export type AdminAccessLoad =
  | { status: 'loading' }
  | { status: 'failed'; description: string | undefined }
  | { status: 'loaded'; access: AdminWorkspaceAccess }

/**
 * Where an admin asks to read a workspace's content without its owner's grant: a reason, and a
 * request that another admin approves from the admin panel's list of pending approvals. Nothing in
 * the workspace is read or changed by asking.
 */
export const RequestContentAccess = ({ admin, workspaceId, access }: {
  admin: RpcStub<AdminApi>
  workspaceId: string
  /** The deployment's admin access level in force: content is asked for only at "content". */
  access: AdminAccessLoad
}) => {
  const [reason, setReason] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [request, setRequest] = useState<AdminContentRequest | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const rememberFocus = useFocusAfterOperation(requesting)
  const form = useRef<HTMLFormElement>(null)
  const outcome = useRef<HTMLParagraphElement>(null)
  const reasonField = useRef<HTMLInputElement>(null)

  // The server refuses a request made all the same. While the level is read, nothing is said and
  // nothing can be sent.
  const unavailable = access.status === 'loading' ? ''
    : access.status === 'failed'
      ? `Couldn’t read this deployment’s admin access level.${
        access.description === undefined ? '' : ` ${access.description}`}`
      : access.access === 'content' ? null
        : 'Reading workspace content is turned off on this deployment: its admin access level is '
          + 'not Content, so nothing can be asked for.'
  const trimmed = reason.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (unavailable !== null || trimmed === '' || requesting) return
    rememberFocus()
    setRequesting(true)
    setProblem(null)
    try {
      const sent = reason
      const made = await admin.requestContentAccess(workspaceId, trimmed)
      // A reason edited while the request was sent is kept: what was sent is what is recorded.
      flushSync(() => {
        setRequest(made)
        setReason(current => current === sent ? '' : current)
      })
      // The emptied field leaves the button disabled, so focus cannot go back to it. What the
      // request needs next takes it, which a screen reader then reads, unless focus has left the
      // form since, or is in the field with a draft the admin is still editing: the outcome's
      // live region says it then.
      const focused = document.activeElement
      const editing = focused === reasonField.current && reasonField.current?.value !== ''
      if (!editing && (focused === document.body || form.current?.contains(focused))) {
        outcome.current?.focus()
      }
    } catch (err) {
      const refusal = adminRefusalMessage(err)
      if (refusal === undefined) logRpcFailure('Failed to request content access:', err)
      setProblem(refusal ?? rpcFailureDescription(err) ?? 'Couldn’t request content access.')
    } finally {
      setRequesting(false)
    }
  }

  return (
    <section className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-kumo-strong">Request content access</h2>
        <p className="text-sm text-kumo-subtle">
          Ask for admins to read this workspace’s content for {GRANT_HOURS} hours without its
          owner’s grant. Another admin approves the request in the admin panel. The workspace’s
          owner is not told, and the reason stays in the admins’ audit log.
        </p>
      </div>

      <form ref={form} noValidate onSubmit={submit} className="grid gap-3">
        <Input
          ref={reasonField}
          label="Why do admins need to read this workspace’s content?"
          autoComplete="off"
          maxLength={MAX_ADMIN_ACCESS_REASON_LENGTH}
          disabled={unavailable !== null}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {access.status === 'failed'
          ? <p role="alert" className="text-sm text-kumo-danger">{unavailable}</p>
          : unavailable && <p className="text-sm text-kumo-subtle">{unavailable}</p>}
        {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={requesting}
            disabled={unavailable !== null || trimmed === ''}
          >
            Request content access
          </Button>
        </div>
      </form>

      <div role="status">
        {request !== null && (
          <div className="space-y-2 border-t border-kumo-line pt-4">
            <p ref={outcome} tabIndex={-1} className="text-sm text-kumo-default focus:outline-none">
              Another admin must approve this. You cannot approve your own request.
            </p>
            <p className="text-sm text-kumo-subtle">
              It waits in the admin panel’s{' '}
              <Link
                to="/admin"
                search={{ tab: 'audit' }}
                hash={PENDING_APPROVALS_ID}
                className="text-kumo-brand hover:underline"
              >
                pending approvals
              </Link>
              {' '}until{' '}
              <time dateTime={request.expiresAt.toISOString()}>{formatFullTimestamp(request.expiresAt)}</time>.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
