import { useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Button, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  MAX_ADMIN_ACCESS_REASON_LENGTH,
  type AdminApi,
  type AdminWorkspaceAccess,
  type AdminWriteRequest,
} from '@gadgets/workshop-shared/api'
import { copyToClipboard } from '../../clipboard'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { useFocusAfterOperation } from './useFocusAfterOperation'
import { adminRefusalMessage, GRANT_HOURS } from './writeLabels'

// Why no request can be made on this deployment, or null when one can. The server refuses a
// request made all the same.
const unavailableBecause = (writesOn: boolean, access: AdminWorkspaceAccess): string | null => {
  if (!writesOn) {
    return 'Admin writes to workspaces are turned off on this deployment, and this request is one. '
      + 'Only its ADMIN_WORKSPACE_WRITES environment variable can turn them on.'
  }
  if (access !== 'content') {
    return 'Reading workspace content is turned off on this deployment: its admin access level is '
      + 'not Content, so nothing can be asked for.'
  }
  return null
}

/**
 * Where an admin asks to read a workspace's content without its owner's grant: a reason, and a
 * request that another admin approves with a passkey at the link it then shows. Nothing in the
 * workspace is read or changed by asking.
 */
export const RequestContentAccess = ({ admin, workspaceId, writesOn, access }: {
  admin: RpcStub<AdminApi>
  workspaceId: string
  /** Whether the deployment lets admins write to workspaces, which this request is. */
  writesOn: boolean
  /** The deployment's admin access level in force: content is asked for only at "content". */
  access: AdminWorkspaceAccess
}) => {
  const [reason, setReason] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [request, setRequest] = useState<AdminWriteRequest | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // What became of the last press of Copy link, until another request replaces the link.
  const [copy, setCopy] = useState<'copied' | 'failed' | null>(null)
  const rememberFocus = useFocusAfterOperation(requesting)
  const form = useRef<HTMLFormElement>(null)
  const outcome = useRef<HTMLParagraphElement>(null)

  const unavailable = unavailableBecause(writesOn, access)
  const trimmed = reason.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (unavailable !== null || trimmed === '' || requesting) return
    rememberFocus()
    setRequesting(true)
    setProblem(null)
    try {
      const made = await admin.requestWorkspaceWrite(workspaceId, 'grantContentAccess', {}, trimmed)
      flushSync(() => {
        setRequest(made)
        setCopy(null)
        setReason('')
      })
      // The emptied field leaves the button disabled, so focus cannot go back to it. What the
      // request needs next takes it, which a screen reader then reads, unless focus has left the
      // form since.
      const focused = document.activeElement
      if (focused === document.body || form.current?.contains(focused)) outcome.current?.focus()
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
          owner’s grant. Another admin approves the request with a passkey. The workspace’s owner
          is not told, and the reason stays in the admins’ audit log.
        </p>
      </div>

      <form ref={form} noValidate onSubmit={submit} className="grid gap-3">
        <Input
          label="Why do admins need to read this workspace’s content?"
          autoComplete="off"
          maxLength={MAX_ADMIN_ACCESS_REASON_LENGTH}
          disabled={unavailable !== null}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {unavailable !== null && <p className="text-sm text-kumo-subtle">{unavailable}</p>}
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

      {request !== null && (
        <div className="space-y-2 border-t border-kumo-line pt-4">
          <p ref={outcome} tabIndex={-1} className="text-sm text-kumo-default focus:outline-none">
            Another admin must approve this. You cannot approve your own request.
          </p>
          <p className="text-sm text-kumo-subtle">Give them this link:</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 font-mono text-xs text-kumo-default break-all">{request.approvalUrl}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void copyToClipboard(request.approvalUrl)
                  .then((copied) => setCopy(copied ? 'copied' : 'failed'))
              }}
            >
              Copy link
            </Button>
          </div>
          <p role="status" className="text-sm text-kumo-subtle">
            {copy === 'copied' && 'Link copied.'}
            {copy === 'failed' && 'Couldn’t copy the link. Select it and copy it by hand.'}
          </p>
          <p className="text-sm text-kumo-subtle">
            The request can be approved until{' '}
            <time dateTime={request.expiresAt.toISOString()}>{formatFullTimestamp(request.expiresAt)}</time>.
          </p>
        </div>
      )}
    </section>
  )
}
