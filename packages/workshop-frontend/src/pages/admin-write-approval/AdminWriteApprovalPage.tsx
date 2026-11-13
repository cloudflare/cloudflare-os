import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Banner, Button, Loader } from '@cloudflare/kumo'
import { ShieldWarning, Warning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_WRITE_ERROR_CODES,
  getAdminWriteErrorCode,
  type AdminApi,
  type AdminWorkspaceAccess,
  type AdminWriteRequest,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { assertPasskey, PasskeyCeremonyError } from '../../features/admin-writes/passkeyCeremony'
import {
  DESTRUCTIVE_WRITES,
  idsNote,
  namesWorkspaceIds,
  REASON_SHOWN_NOTE,
  WRITE_ACTION_LABELS,
  WRITE_CONSEQUENCES,
  writeArgRows,
} from '../../features/admin-writes/writeLabels'
import { latestReads } from '../../features/deployment-updates/latestReads'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'

type Operation = 'approve' | 'deny'

// Where loading the request stands. A loaded request is held apart, since it changes afterwards.
// The stub sits inside this object so that useState does not call it, as it would a bare stub,
// which is callable.
type Load =
  | { status: 'loading' }
  | { status: 'noAccess' }
  | { status: 'writesOff' }
  | { status: 'notFound' }
  | { status: 'failed'; description: string | undefined }
  | { status: 'loaded'; admin: RpcStub<AdminApi>; access: AdminWorkspaceAccess }

// What stopped an approval or a denial: the admin has no passkey to approve with, or a message.
// It is shown while the request is pending: a later reading may find the request resolved all the
// same, and then only what became of it is true.
type Problem = 'passkeyRequired' | { message: string }

const FAILURES: Record<Operation, string> = {
  approve: 'Couldn’t approve the write.',
  deny: 'Couldn’t deny the write.',
}

const STALE_MESSAGE =
  'This request is no longer pending, and the page couldn’t read what became of it. Reload the page.'

const VIA_LABELS: Record<AdminWriteRequest['via'], string> = {
  cli: 'through the CLI',
  api: 'through the API',
}

const TICK_MS = 15_000
const POLL_MS = 5_000

const LINK_CLASS = 'text-kumo-brand hover:underline'

// A refusal the admin can act on, as the page words it. Undefined for any other failure.
const refusalOf = (err: unknown): Problem | undefined => {
  const code = getAdminWriteErrorCode(err)
  if (code === ADMIN_WRITE_ERROR_CODES.passkeyRequired) return 'passkeyRequired'
  if (code === ADMIN_WRITE_ERROR_CODES.passkeyRefused) {
    return { message: 'The passkey confirmation was not accepted. Try again.' }
  }
  if (err instanceof PasskeyCeremonyError && err.reason === 'unsupported') return { message: err.message }
  return undefined
}

// What became of a request that is no longer pending.
const outcomeOf = (request: AdminWriteRequest): { title: string; detail?: string } | null => {
  const resolver = request.resolvedBy ?? 'an admin'
  switch (request.state) {
    case 'pending': return null
    case 'approved': return { title: `Approved by ${resolver}. The workspace is running it.` }
    case 'applied': return { title: 'Applied', detail: request.outcome }
    case 'failed': return { title: 'Failed', detail: request.error }
    case 'denied': return { title: `Denied by ${resolver}` }
    case 'expired': return { title: 'Expired', detail: request.error }
  }
}

// The server ends a request that has run out when it is next read, so one shown as pending may be
// past its time.
const timeLeft = (expiresAt: Date, now: number): string => {
  const left = expiresAt.getTime() - now
  return left > 0 ? `in ${Math.ceil(left / 60_000)} min` : 'any moment now'
}

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 space-y-6">
    <h1 className="text-2xl font-semibold text-kumo-default">Approve a write</h1>
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
 * Where an admin approves a write request with a passkey, or denies it. It shows what the request
 * would do, to which workspace and why, as the request states it, and what became of a request
 * that is no longer pending. It is the Workshop's one page that runs an approval's passkey
 * ceremony; the server takes an approval from any admin session that presents a valid assertion.
 */
const AdminWriteApprovalPage = ({ requestId }: { requestId: string }) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [request, setRequest] = useState<AdminWriteRequest | null>(null)
  // Only the latest reading of the request applies (see latestReads).
  const [read] = useState(() => latestReads<AdminWriteRequest>(setRequest))
  const [now, setNow] = useState(() => Date.now())
  const [running, setRunning] = useState<Operation | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const statusRegion = useRef<HTMLDivElement>(null)

  const admin = load.status === 'loaded' ? load.admin : null
  const state = request?.state

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    const fail = (err: unknown) => {
      logRpcFailure('Failed to load the write request:', err)
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
        // Both calls are sent before either answers.
        const [written, settings] = await Promise.allSettled([
          api.getWorkspaceWrite(requestId), api.getSettings(),
        ])
        if (cancelled) return
        if (written.status === 'rejected') {
          const code = getAdminWriteErrorCode(written.reason)
          if (code === ADMIN_WRITE_ERROR_CODES.writesOff) setLoad({ status: 'writesOff' })
          else if (code === ADMIN_WRITE_ERROR_CODES.requestNotFound) setLoad({ status: 'notFound' })
          else fail(written.reason)
          return
        }
        // The level decides what the page says of ids it cannot resolve, so it is never guessed.
        if (settings.status === 'rejected') {
          fail(settings.reason)
          return
        }
        setRequest(written.value)
        setLoad({ status: 'loaded', admin: api, access: settings.value.adminWorkspaceAccess.effective })
      } catch (err) {
        if (!cancelled) fail(err)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]()
    }
  }, [authenticatedApi, requestId])

  // The time left is counted down while the request can still be approved.
  useEffect(() => {
    if (state !== 'pending') return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [state])

  // Two kinds of request change without this page: an approved one settles when the workspace
  // answers or the server gives up on its answer, and the server ends a pending one whose time has
  // passed when it is next read. Such a request is read again until it has changed.
  const watched = state === 'approved'
    || (request?.state === 'pending' && request.expiresAt.getTime() <= now)
  useEffect(() => {
    if (admin === null || !watched) return
    // No reading starts while one is awaited. It would replace that one (see latestReads), so
    // with every answer slower than the interval none would ever be applied.
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      reading = true
      read(() => admin.getWorkspaceWrite(requestId))
        .catch((err: unknown) => { logRpcFailure('Failed to read the write request:', err) })
        .finally(() => { reading = false })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [admin, read, requestId, watched])

  // Once a request this page showed as pending is resolved, its buttons are gone, and with them
  // the focus one of them had. What became of the request gets it. A request can also run out
  // while the admin is elsewhere on the page, and focus that is elsewhere stays there.
  const shownPending = useRef(false)
  useEffect(() => {
    if (state === 'pending') shownPending.current = true
    else if (state !== undefined && shownPending.current) {
      shownPending.current = false
      if (document.activeElement === document.body) statusRegion.current?.focus()
    }
  }, [state])

  // An operation disables the button that started it, and a browser takes focus from a control
  // that becomes disabled without giving it back. So when the request is still pending afterwards,
  // the control that had focus gets it again, unless focus has gone elsewhere since.
  const focusBeforeOperation = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (running !== null) return
    if (document.activeElement === document.body) focusBeforeOperation.current?.focus()
    focusBeforeOperation.current = null
  }, [running])

  // Reads a request that is known to be resolved, to show what became of it. The buttons stay
  // while that reading fails, so the page says they no longer apply.
  const readResolved = async (api: RpcStub<AdminApi>) => {
    try {
      await read(() => api.getWorkspaceWrite(requestId))
    } catch (err) {
      logRpcFailure('Failed to read the write request:', err)
      setProblem({ message: STALE_MESSAGE })
    }
  }

  // Runs an approval or a denial, one at a time, and shows what stopped it.
  const run = async (operation: Operation, work: (api: RpcStub<AdminApi>) => Promise<void>) => {
    if (admin === null || running !== null) return
    focusBeforeOperation.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setRunning(operation)
    setProblem(null)
    try {
      await work(admin)
    } catch (err) {
      // The admin dismissed the browser's prompt, which they need not be told.
      if (err instanceof PasskeyCeremonyError && err.reason === 'cancelled') return
      // Someone else resolved the request first, or it expired.
      if (getAdminWriteErrorCode(err) === ADMIN_WRITE_ERROR_CODES.requestNotPending) {
        await readResolved(admin)
        return
      }
      const refusal = refusalOf(err)
      if (refusal === undefined) logRpcFailure(FAILURES[operation], err)
      setProblem(refusal ?? { message: rpcFailureDescription(err) ?? FAILURES[operation] })
    } finally {
      setRunning(null)
    }
  }

  const approve = () => run('approve', async (api) => {
    const challenge = await api.beginWorkspaceWriteApproval(requestId)
    const approved = await api.approveWorkspaceWrite(requestId, await assertPasskey(challenge))
    // Shown as the latest reading, so that one begun before the approval cannot replace it. The
    // approval itself is not run as a reading: one that replaced it would hide its refusal.
    await read(() => Promise.resolve(approved))
  })

  const deny = () => run('deny', async (api) => {
    await api.denyWorkspaceWrite(requestId)
    await readResolved(api)
  })

  if (load.status === 'noAccess') {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">You don't have access to this page.</p>
      </div>
    )
  }
  if (load.status === 'loading') {
    return <Frame><Loader aria-label="Loading the write request" /></Frame>
  }
  if (load.status === 'writesOff') {
    return (
      <Frame>
        <p className="text-sm text-kumo-default">
          Admin writes to workspaces are turned off on this deployment, so there is nothing to
          approve. Only its <code className="font-mono text-xs">ADMIN_WORKSPACE_WRITES</code>{' '}
          environment variable can turn them on.
        </p>
      </Frame>
    )
  }
  if (load.status === 'notFound') {
    return (
      <Frame>
        <p className="text-sm text-kumo-default">
          No such write request. A request can be opened for a day after it is resolved. After
          that, what came of it is in the{' '}
          <Link to="/admin" search={{ tab: 'audit' }} className={LINK_CLASS}>audit log</Link>.
        </p>
      </Frame>
    )
  }
  if (load.status === 'failed' || request === null) {
    return (
      <Frame>
        <p role="alert" className="text-sm text-kumo-danger">
          Couldn’t load the write request.
          {load.status === 'failed' && load.description !== undefined && ` ${load.description}`}
        </p>
      </Frame>
    )
  }

  const pending = request.state === 'pending'
  const destructive = DESTRUCTIVE_WRITES.has(request.action)
  const consequence = WRITE_CONSEQUENCES[request.action]
  const outcome = outcomeOf(request)

  return (
    <Frame>
      {pending && currentUser !== null && (
        <p className="text-sm text-kumo-subtle">You are approving as {currentUser.id}.</p>
      )}

      <div className="bg-kumo-elevated border border-kumo-line rounded-xl px-6 py-3">
        <dl className="divide-y divide-kumo-line">
          <Row label="Workspace">
            {request.workspaceTitle === '' ? 'Untitled' : request.workspaceTitle}
            <span className="block font-mono text-xs text-kumo-subtle break-all">{request.workspaceId}</span>
          </Row>
          <Row label="Owner">{request.workspaceOwner}</Row>
          <Row label="Action">{WRITE_ACTION_LABELS[request.action]}</Row>
          {writeArgRows(request.action, request.args).map(({ label, value }) => (
            <Row key={label} label={label}>{value}</Row>
          ))}
        </dl>
        {namesWorkspaceIds(request.args) && (
          <p className="border-t border-kumo-line py-3 text-sm text-kumo-subtle">
            {idsNote(load.access)}{' '}
            <Link
              to="/admin"
              search={{ tab: 'audit', workspace: request.workspaceId }}
              className={LINK_CLASS}
            >
              This workspace in the audit log
            </Link>
          </p>
        )}
        <dl className="divide-y divide-kumo-line border-t border-kumo-line">
          <Row label="Reason">
            <span className="block whitespace-pre-wrap">{request.reason}</span>
            <span className="mt-1 block text-kumo-subtle">{REASON_SHOWN_NOTE}</span>
          </Row>
          <Row label="Requested by">{request.requestedBy} {VIA_LABELS[request.via]}</Row>
          <Row label="Expires">
            <time dateTime={request.expiresAt.toISOString()}>{formatFullTimestamp(request.expiresAt)}</time>
            {pending && ` (${timeLeft(request.expiresAt, now)})`}
          </Row>
        </dl>
      </div>

      {pending && destructive && (
        <Banner variant="error" icon={<Warning />} title="This cannot be undone." />
      )}
      {pending && consequence !== undefined && <Banner variant="alert" description={consequence} />}

      {pending && (
        <div className="flex flex-wrap gap-3">
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={running === 'approve'}
            disabled={running !== null}
            onClick={() => { void approve() }}
          >
            Approve with passkey
          </Button>
          <Button
            variant="secondary"
            loading={running === 'deny'}
            disabled={running !== null}
            onClick={() => { void deny() }}
          >
            Deny
          </Button>
        </div>
      )}

      {pending && problem !== null && (
        <p role="alert" className="text-sm text-kumo-danger">
          {problem === 'passkeyRequired' ? (
            <>
              You have no passkey to approve with.{' '}
              <Link to="/admin" search={{ tab: 'access' }} className={LINK_CLASS}>Enrol a passkey first</Link>
              , then open this page again.
            </>
          ) : problem.message}
        </p>
      )}

      <div ref={statusRegion} role="status" tabIndex={-1} className="space-y-1 focus:outline-none">
        {outcome !== null && (
          <>
            <p className="text-base font-medium text-kumo-strong">{outcome.title}</p>
            {outcome.detail !== undefined && (
              <p className="text-sm text-kumo-default whitespace-pre-wrap break-words">{outcome.detail}</p>
            )}
          </>
        )}
      </div>
    </Frame>
  )
}

export default AdminWriteApprovalPage
