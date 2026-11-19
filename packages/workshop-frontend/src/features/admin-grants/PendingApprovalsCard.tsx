import { useEffect, useReducer, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminContentRequest } from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { adminRefusalMessage, GRANT_HOURS, PENDING_APPROVALS_ID } from './grantLabels'

// Names that differ only by the case of ASCII letters are one admin, as the deployment's list of
// admins matches them. The server decides: this only spares a requester an approval it refuses.
const asciiLowerCase = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

// What the list shows: the requests, or why there are none to show.
type Listing =
  | { status: 'loading' }
  | { status: 'failed'; description: string }
  | { status: 'loaded'; requests: AdminContentRequest[] }

type Problem = { id: string; title: string; text: string }

type State = {
  listing: Listing
  /** Counts the reads of the list, failed ones too: focus a decision lost waits for the next. */
  reads: number
  /** Bumped to list again after a decision. */
  loads: number
  /** The request a decision is being sent for. */
  deciding: { id: string; approve: boolean } | null
  /** What the last decision said when it failed. */
  problem: Problem | null
  /** What the last decision did, said in the card's live region. */
  said: string | null
}

// What a decision did. `removed` when the request is pending no more, whatever the decision said:
// its row goes at once, so that it can't be decided again before the list is read again.
type Outcome = { removed: boolean; said?: string; problem?: Problem }

type Action =
  | { type: 'listed'; requests: AdminContentRequest[] }
  | { type: 'listFailed'; description: string }
  | { type: 'decide'; id: string; approve: boolean }
  | { type: 'decided'; id: string } & Outcome

const initialState: State = { listing: { status: 'loading' }, reads: 0, loads: 0, deciding: null, problem: null, said: null }

const reduce = (state: State, action: Action): State => {
  switch (action.type) {
    case 'listed':
      return { ...state, listing: { status: 'loaded', requests: action.requests }, reads: state.reads + 1 }
    case 'listFailed':
      return { ...state, listing: { status: 'failed', description: action.description }, reads: state.reads + 1 }
    case 'decide':
      return { ...state, deciding: { id: action.id, approve: action.approve }, problem: null, said: null }
    case 'decided': {
      const { listing } = state
      return {
        ...state,
        listing: action.removed && listing.status === 'loaded'
          ? { ...listing, requests: listing.requests.filter((r) => r.id !== action.id) }
          : listing,
        deciding: null,
        loads: state.loads + 1,
        said: action.said ?? null,
        problem: action.problem ?? null,
      }
    }
  }
}

/**
 * Every admin's pending requests to read a workspace's content without its owner, deployment-wide,
 * with Approve and Deny. A request is approved by an admin other than the one who made it, so the
 * signed-in admin's own requests read as waiting for another admin, and can only be denied. A
 * request filed through the admin connection (by an agent, gadget code or the owner's own session
 * of it) is its workspace owner's, shown with the workspace and the chat it came from: nobody who was in that workspace may approve it, which
 * the server alone knows, and says when it refuses them. An approval has the workspace give the
 * grant at once; nothing is shown to the workspace's members.
 */
export const PendingApprovalsCard = ({ admin, userId, refreshes = 0, onDecided }: {
  admin: RpcStub<AdminApi>
  /** The signed-in admin, by canonical user id. */
  userId: string
  /** Increases to list the requests again, as the Audit tab's Refresh does. */
  refreshes?: number
  /** Called once a decision has settled, whatever it said, so that its record shows beside. */
  onDecided?: () => void
}) => {
  const [state, dispatch] = useReducer(reduce, initialState)
  const { listing, deciding, problem, said } = state
  const heading = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // The decided request's place in the list, set once its decision has settled: the row the next
  // read puts there, or else the heading, takes focus, if the decision lost it.
  const refocusAt = useRef<number | null>(null)

  // A link to the queue lands here: the router looked for its target as the admin page began
  // loading, before the Audit tab, and with it this card, was rendered.
  useEffect(() => {
    if (window.location.hash === `#${PENDING_APPROVALS_ID}`) {
      document.getElementById(PENDING_APPROVALS_ID)?.scrollIntoView()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    admin.listContentAccessRequests().then(
      (requests) => {
        if (!cancelled) dispatch({ type: 'listed', requests: requests.filter((r) => r.state === 'pending') })
      },
      (err: unknown) => {
        if (cancelled) return
        logRpcFailure('Failed to list the pending approvals:', err)
        dispatch({ type: 'listFailed', description: rpcFailureDescription(err) ?? 'Couldn’t load them.' })
      },
    )
    return () => { cancelled = true }
  }, [admin, state.loads, refreshes])

  // After a read, not after the decision's trim: the read can take out more rows than it did.
  useEffect(() => {
    const at = refocusAt.current
    if (at === null) return
    refocusAt.current = null
    // Only focus that was lost, with the row that held it: focus anywhere else, a workspace link
    // that survived the reload included, stays where it is.
    const focused = document.activeElement
    if (focused !== null && focused !== document.body) return
    const rows = list.current?.querySelectorAll('li') ?? []
    const row = rows.length === 0 ? undefined : rows[Math.min(at, rows.length - 1)]
    const target = row?.querySelector<HTMLButtonElement>('button:not([disabled])') ?? heading.current
    target?.focus()
  }, [state.reads])

  const decide = async (request: AdminContentRequest, approve: boolean) => {
    const at = listing.status === 'loaded' ? Math.max(0, listing.requests.findIndex((r) => r.id === request.id)) : 0
    dispatch({ type: 'decide', id: request.id, approve })
    let outcome: Outcome
    try {
      if (approve) {
        const settled = await admin.approveContentAccess(request.id)
        outcome = settled.state === 'failed'
          ? { removed: true, problem: { id: request.id, title: request.workspaceTitle, text: settled.error ?? 'The workspace gave no grant.' } }
          : { removed: true, said: `Approved. Admins can read ${settled.workspaceTitle || 'the workspace'} until the grant ends.` }
      } else {
        await admin.denyContentAccess(request.id)
        const own = asciiLowerCase(request.requestedBy) === asciiLowerCase(userId)
        outcome = { removed: true, said: `${own ? 'Withdrawn' : 'Denied'}: ${request.workspaceTitle || 'Untitled'}.` }
      }
    } catch (err) {
      const refusal = adminRefusalMessage(err)
      if (refusal === undefined) logRpcFailure('Failed to decide a content access request:', err)
      outcome = { removed: false, problem: { id: request.id, title: request.workspaceTitle, text: refusal ?? rpcFailureDescription(err) ?? 'Couldn’t send that.' } }
    }
    // Set only now, so that a read that lands while the decision is sent leaves focus alone.
    refocusAt.current = at
    dispatch({ type: 'decided', id: request.id, ...outcome })
    onDecided?.()
  }

  const self = asciiLowerCase(userId)
  // A request the decision took out of the list, as a failed approval does, has no row to say
  // what went wrong beside: the card says it.
  const unlisted = problem !== null &&
    !(listing.status === 'loaded' && listing.requests.some((r) => r.id === problem.id))

  return (
    <section
      id={PENDING_APPROVALS_ID}
      aria-labelledby={`${PENDING_APPROVALS_ID}-heading`}
      className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-4"
    >
      <div className="space-y-1">
        <h2
          ref={heading}
          id={`${PENDING_APPROVALS_ID}-heading`}
          tabIndex={-1}
          className="text-lg font-semibold text-kumo-strong focus:outline-none"
        >
          Pending approvals
        </h2>
        <p className="text-sm text-kumo-subtle">
          Requests to read a workspace’s content for {GRANT_HOURS} hours without its owner’s grant.
          An admin other than the one who asked approves each. The workspace’s owner is not told, and
          every request, approval and denial is in the audit log.
        </p>
      </div>

      {/* Mounted while empty, so that assistive technology tracks it before its first message. */}
      <p role="status" className="sr-only">{said}</p>
      {said !== null && <p aria-hidden="true" className="text-sm text-kumo-default">{said}</p>}

      {unlisted && (
        <p role="alert" className="text-sm text-kumo-danger">
          {problem.title || 'Untitled'}: {problem.text}
        </p>
      )}
      {listing.status === 'loading' && <p className="text-sm text-kumo-subtle">Loading…</p>}
      {listing.status === 'failed' && <p role="alert" className="text-sm text-kumo-danger">{listing.description}</p>}
      {listing.status === 'loaded' && listing.requests.length === 0 && (
        <p className="text-sm text-kumo-subtle">No request is waiting.</p>
      )}
      {listing.status === 'loaded' && listing.requests.length > 0 && (
        <ul ref={list} className="space-y-3">
          {listing.requests.map((request) => {
            const own = asciiLowerCase(request.requestedBy) === self
            const busy = deciding?.id === request.id
            return (
              <li key={request.id} className="border border-kumo-line rounded-lg px-4 py-3 space-y-2">
                <div className="text-sm">
                  <Link
                    to="/admin/workspace/$workspaceId"
                    params={{ workspaceId: request.workspaceId }}
                    className="font-medium text-kumo-brand hover:underline"
                  >
                    {request.workspaceTitle || 'Untitled'}
                  </Link>
                  <span className="text-kumo-subtle"> · owned by {request.workspaceOwner}</span>
                </div>
                <p className="text-sm text-kumo-default whitespace-pre-wrap break-words">{request.reason}</p>
                <p className="text-xs text-kumo-subtle">
                  Asked for by {request.requestedBy}{request.agent && ' via the admin connection'}.
                  Open until{' '}
                  <time dateTime={request.expiresAt.toISOString()}>{formatFullTimestamp(request.expiresAt)}</time>.
                </p>
                {request.agent && (
                  <p className="text-xs text-kumo-subtle">
                    From workspace{' '}
                    <Link
                      to="/admin/workspace/$workspaceId"
                      params={{ workspaceId: request.agent.workspaceId }}
                      className="font-mono break-all text-kumo-brand hover:underline"
                    >
                      {request.agent.workspaceId}
                    </Link>
                    {request.agent.chatId !== undefined && `, chat ${request.agent.chatId}`}. An admin
                    who was not in that workspace must approve it.
                  </p>
                )}
                {problem?.id === request.id && (
                  <p role="alert" className="text-sm text-kumo-danger">{problem.text}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {own
                    ? <span className="text-sm text-kumo-subtle">Your request: waiting for another admin.</span>
                    : (
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy && deciding.approve}
                        disabled={deciding !== null}
                        onClick={() => void decide(request, true)}
                      >
                        Approve
                      </Button>
                    )}
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy && !deciding.approve}
                    disabled={deciding !== null}
                    onClick={() => void decide(request, false)}
                  >
                    {own ? 'Withdraw' : 'Deny'}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
