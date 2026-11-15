import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Button, Input, Loader } from '@cloudflare/kumo'
import { ShieldWarning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import {
  MAX_ADMIN_ACCESS_REASON_LENGTH,
  type AdminAccessGrant,
  type AdminApi,
  type AdminWorkspaceAccess,
  type AdminWorkspaceDescription,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { RequestContentAccess } from '../../features/admin-writes/RequestContentAccess'
import { useFocusAfterOperation } from '../../features/admin-writes/useFocusAfterOperation'
import { adminRefusalMessage } from '../../features/admin-writes/writeLabels'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { AccessGrants } from './AccessGrants'

// Where loading the admin API stands. The stub sits inside this object so that useState does not
// call it, as it would a bare stub, which is callable.
type Load =
  | { status: 'loading' }
  | { status: 'noAccess' }
  | { status: 'failed'; description: string | undefined }
  | { status: 'loaded'; admin: RpcStub<AdminApi>; writesOn: boolean; access: AdminWorkspaceAccess }

// An open view, as inspectWorkspace() promises it: calls are made on the promise, which stands for
// the view, and disposing it disposes the view.
type View = ReturnType<RpcStub<AdminApi>['inspectWorkspace']>

const LINK_CLASS = 'text-kumo-brand hover:underline'

// What a failed call says: the server's message for a refusal it names by code, and its account
// of any other failure, which is logged as well.
const failureOf = (err: unknown, fallback: string): string => {
  const refusal = adminRefusalMessage(err)
  if (refusal === undefined) logRpcFailure(fallback, err)
  return refusal ?? rpcFailureDescription(err) ?? fallback
}

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 space-y-6">
    <h1 className="text-2xl font-semibold text-kumo-default">Workspace admin view</h1>
    {children}
  </div>
)

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
    <dt className="text-sm text-kumo-subtle">{label}</dt>
    <dd className="min-w-0 text-sm text-kumo-default break-words">{children}</dd>
  </div>
)

/**
 * An admin's page for one workspace: it opens a metadata view of the workspace for a reason, shows
 * whose it is and the live grants it stores, ends a grant a second admin approved, and asks for
 * content access. It never opens a view for content and shows none: content is read through the
 * API and the CLI. Every call it makes into the workspace is recorded in the audit log.
 */
const AdminWorkspacePage = ({ workspaceId, reportId }: {
  workspaceId: string
  /** The issue report the admin came from, which the reason then starts as. */
  reportId?: string
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reason, setReason] = useState(reportId === undefined ? '' : `Issue report ${reportId}`)
  const [opening, setOpening] = useState(false)
  const [description, setDescription] = useState<AdminWorkspaceDescription | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // The view `description` was read through, kept to read it again and to dispose it.
  const view = useRef<View | null>(null)
  // Counts the admin sessions the page has left, so that a view opened over one of them is
  // disposed when it arrives and never shown.
  const sessionsLeft = useRef(0)
  const rememberFocus = useFocusAfterOperation(opening)
  const reasonField = useRef<HTMLInputElement>(null)

  const admin = load.status === 'loaded' ? load.admin : null
  const trimmed = reason.trim()

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    const fail = (err: unknown) => {
      logRpcFailure('Failed to load the admin API:', err)
      setLoad({ status: 'failed', description: rpcFailureDescription(err) })
    }
    void (async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]()
          return
        }
        if (api === null) {
          setLoad({ status: 'noAccess' })
          return
        }
        stub = api
        const settings = await api.getSettings()
        if (cancelled) return
        setLoad({
          status: 'loaded',
          admin: api,
          writesOn: settings.adminWorkspaceWrites,
          access: settings.adminWorkspaceAccess.effective,
        })
      } catch (err) {
        if (!cancelled) fail(err)
      }
    })()
    return () => {
      cancelled = true
      sessionsLeft.current++
      // A view lives in the session it was opened over, so it goes with that session's API.
      view.current?.[Symbol.dispose]()
      view.current = null
      setDescription(null)
      stub?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const open = async (event: FormEvent) => {
    event.preventDefault()
    if (admin === null || trimmed === '' || opening) return
    rememberFocus()
    setOpening(true)
    setProblem(null)
    const session = sessionsLeft.current
    // The view is opened for metadata. describe() is sent on the promise of the view, so both
    // calls leave before either answers.
    const opened = admin.inspectWorkspace(workspaceId, trimmed)
    try {
      const described = await opened.describe()
      if (sessionsLeft.current !== session) {
        opened[Symbol.dispose]()
        return
      }
      view.current?.[Symbol.dispose]()
      view.current = opened
      setDescription(described)
    } catch (err) {
      opened[Symbol.dispose]()
      if (sessionsLeft.current === session) setProblem(failureOf(err, 'Couldn’t open the workspace.'))
    } finally {
      setOpening(false)
    }
  }

  // Ends a grant, then reads the workspace again through the open view. A view that no longer
  // answers (it has expired, or inspection was turned off) is closed, and the page says why.
  const endGrant = async (grant: AdminAccessGrant, endReason: string) => {
    if (admin === null) return
    await admin.endWorkspaceGrant(workspaceId, grant.id, endReason)
    const current = view.current
    if (current === null) return
    try {
      const described = await current.describe()
      if (view.current === current) setDescription(described)
    } catch (err) {
      if (view.current !== current) return
      current[Symbol.dispose]()
      view.current = null
      const said = failureOf(err, 'The grant was ended, but the workspace couldn’t be read again.')
      flushSync(() => {
        setDescription(null)
        setProblem(said)
      })
      // The grants went with the view, and with them the dialog that held focus. The reason field
      // takes it: the workspace is opened again from there.
      reasonField.current?.focus()
    }
  }

  if (load.status === 'noAccess') {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">You don't have access to this page.</p>
      </div>
    )
  }
  if (load.status === 'loading') {
    return <Frame><Loader aria-label="Loading the admin view" /></Frame>
  }
  if (load.status === 'failed') {
    return (
      <Frame>
        <p role="alert" className="text-sm text-kumo-danger">
          Couldn’t load the admin view.
          {load.description !== undefined && ` ${load.description}`}
        </p>
      </Frame>
    )
  }

  return (
    <Frame>
      <p className="font-mono text-xs text-kumo-subtle break-all">{workspaceId}</p>

      <form noValidate onSubmit={open} className="grid gap-3">
        <Input
          ref={reasonField}
          label="Why are you looking at this workspace?"
          description="A reason is required. The audit log records it with the open and with every call made through the view."
          autoComplete="off"
          autoFocus
          maxLength={MAX_ADMIN_ACCESS_REASON_LENGTH}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
        <div>
          <Button type="submit" variant="primary" loading={opening} disabled={trimmed === ''}>Open</Button>
        </div>
      </form>

      {description !== null && (
        <>
          <div className="bg-kumo-elevated border border-kumo-line rounded-xl px-6 py-3">
            <dl className="divide-y divide-kumo-line">
              <Row label="Workspace">
                {description.title === '' ? 'Untitled' : description.title}
                <span className="block font-mono text-xs text-kumo-subtle break-all">{description.id}</span>
              </Row>
              <Row label="Owner">
                {description.owner.name}
                <span className="block font-mono text-xs text-kumo-subtle break-all">{description.owner.id}</span>
              </Row>
              <Row label="View expires">
                <time dateTime={description.expiresAt.toISOString()}>
                  {formatFullTimestamp(description.expiresAt)}
                </time>
              </Row>
            </dl>
          </div>
          <AccessGrants grants={description.grants} onEnd={endGrant} />
        </>
      )}

      <RequestContentAccess
        admin={load.admin}
        workspaceId={workspaceId}
        writesOn={load.writesOn}
        access={load.access}
      />

      <p className="text-sm text-kumo-subtle">
        <Link to="/admin" search={{ tab: 'audit', workspace: workspaceId }} className={LINK_CLASS}>
          This workspace in the audit log
        </Link>
        . This page shows no content: under a live grant, content is read through the API or the
        CLI, with a view opened for content.
      </p>
    </Frame>
  )
}

export default AdminWorkspacePage
