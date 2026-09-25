import { useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { ACTION_ERROR_MESSAGES, getActionErrorCode } from '@gadgets/workshop-shared/api'
import type { ActionLogEntry, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useActions, type ActionsState } from '../../useActions'

/**
 * Batch review of the pending action log, one Gatekeeper connection at a time.
 *
 * The reviewed boundary of each connection is frozen when the user first opens Review, so a batch
 * only ever authorizes rows that were on screen; later arrivals wait behind includeNewActions().
 * Vetoes are browser-local intent until applyBatch() submits them — nothing here reserves a
 * record against an auto-approval rule or another reviewer, and no decision is ever written
 * optimistically: the action subscription carries every real outcome.
 */
export const useActionReview = (
  overseer: RpcStub<Overseer> | null,
  { workspaceId, active, connected }: {
    workspaceId: string | undefined
    active: boolean
    connected: boolean
  },
): ActionReview => {
  const toasts = useKumoToastManager()
  const { status, pending } = useActions(overseer)
  const [drafts, setDrafts] = useState(NO_DRAFTS)
  const [initialized, setInitialized] = useState(false)
  const [applying, setApplying] = useState(NO_CONNECTIONS)
  const [errors, setErrors] = useState(NO_ERRORS)
  // Identity fence: a completion whose session has been replaced belongs to a stub, workspace or
  // mount that is gone. Doubles as the guard that de-duplicates clicks before the busy render.
  const sessionRef = useRef({ inFlight: new Set<WorkpieceId>() })

  useEffect(() => {
    setApplying(NO_CONNECTIONS)
    return () => { sessionRef.current = { inFlight: new Set() } }
  }, [overseer, workspaceId])

  // Drafts survive a reconnect within the workspace, but never follow the user to another one.
  useEffect(() => {
    setDrafts(NO_DRAFTS)
    setInitialized(false)
    setErrors(NO_ERRORS)
  }, [workspaceId])

  const ready = status === 'ready'
  // Freeze each connection's boundary the first time the user actually looks at a complete
  // pending snapshot: an incomplete one would authorize rows they never saw.
  useEffect(() => {
    if (initialized || !active || !connected || !ready) return
    const captured = new Map<WorkpieceId, Draft>()
    for (const record of pending) {
      if (record.type !== 'action' || record.gatekeeperId === undefined) continue
      const draft = captured.get(record.gatekeeperId)
      if (draft === undefined || record.id > draft.boundary) {
        captured.set(record.gatekeeperId, { boundary: record.id, vetoes: NO_VETOES })
      }
    }
    setDrafts(captured)
    setInitialized(true)
  }, [initialized, active, connected, ready, pending])

  const canEdit = connected && ready && initialized

  const buckets = new Map<WorkpieceId, Bucket>()
  // A pending action can only be applied through its connection; one without is unreachable here.
  const unavailable: ReviewAction[] = []
  for (const record of pending) {
    if (record.type !== 'action') continue
    if (record.gatekeeperId === undefined) {
      unavailable.push(record)
      continue
    }
    let bucket = buckets.get(record.gatekeeperId)
    if (bucket === undefined) {
      bucket = { actions: [], newActions: [], newest: record }
      buckets.set(record.gatekeeperId, bucket)
    } else if (record.id > bucket.newest.id) {
      bucket.newest = record
    }
    const boundary = drafts.get(record.gatekeeperId)?.boundary
    if (boundary !== undefined && record.id <= boundary) bucket.actions.push(record)
    else bucket.newActions.push(record)
  }

  const groups: ReviewGroup[] = [...buckets].map(([gatekeeperId, bucket]) => {
    // The gatekeeper publishes in ascending workspace-id order; timestamps can disagree.
    bucket.actions.sort(byId)
    bucket.newActions.sort(byId)
    const draft = drafts.get(gatekeeperId)
    return {
      gatekeeperId,
      resourceTitle: bucket.newest.resourceTitle,
      resourceUrl: bucket.newest.resourceUrl,
      throughId: draft?.boundary,
      actions: bucket.actions,
      newActions: bucket.newActions,
      vetoIds: bucket.actions.filter(record => draft?.vetoes.has(record.id))
        .map(record => record.id),
      applying: applying.has(gatekeeperId),
      // A ready snapshot with nothing left to review has answered the failed submission.
      error: bucket.actions.length === 0 && ready ? undefined : errors.get(gatekeeperId),
    }
  }).toSorted((a, b) => lowestPendingId(a) - lowestPendingId(b))

  const blockedAutoApprovalConnections = new Map<WorkpieceId, AutoApprovalBlocker>()
  for (const gatekeeperId of applying) blockedAutoApprovalConnections.set(gatekeeperId, 'applying')
  for (const group of groups) {
    if (group.vetoIds.length > 0 && !group.applying) {
      blockedAutoApprovalConnections.set(group.gatekeeperId, 'vetoed')
    }
  }

  const editable = (gatekeeperId: WorkpieceId) => {
    const group = groups.find(candidate => candidate.gatekeeperId === gatekeeperId)
    return canEdit && group !== undefined && !group.applying ? group : undefined
  }

  const setVeto = (gatekeeperId: WorkpieceId, actionId: number, vetoed: boolean) => {
    const group = editable(gatekeeperId)
    if (!group?.actions.some(record => record.id === actionId)) return
    setDrafts(previous => {
      const draft = previous.get(gatekeeperId)
      if (draft === undefined) return previous
      const vetoes = new Set(draft.vetoes)
      if (vetoed) vetoes.add(actionId)
      else vetoes.delete(actionId)
      return new Map(previous).set(gatekeeperId, { ...draft, vetoes })
    })
  }

  /** Advance this connection's boundary over its arrivals. The only thing that ever widens one. */
  const includeNewActions = (gatekeeperId: WorkpieceId) => {
    const group = editable(gatekeeperId)
    if (group === undefined || group.newActions.length === 0) return
    const boundary = group.newActions.at(-1)!.id
    setDrafts(previous => new Map(previous).set(gatekeeperId, {
      boundary,
      vetoes: previous.get(gatekeeperId)?.vetoes ?? NO_VETOES,
    }))
  }

  const applyBatch = async (gatekeeperId: WorkpieceId) => {
    const group = editable(gatekeeperId)
    const session = sessionRef.current
    if (overseer === null || group?.throughId === undefined) return
    if (group.actions.length === 0 || session.inFlight.has(gatekeeperId)) return

    // The request is immutable once sent: an arrival during the await stays outside it.
    const { throughId, vetoIds } = group
    session.inFlight.add(gatekeeperId)
    setApplying(previous => new Set(previous).add(gatekeeperId))
    setErrors(previous => without(previous, gatekeeperId))
    try {
      await overseer.applyActionsThrough(throughId, [...vetoIds])
    } catch (err) {
      console.error('Failed to apply action batch:', err)
      const code = getActionErrorCode(err)
      const message = code === undefined ? UNKNOWN_BATCH_ERROR : ACTION_ERROR_MESSAGES[code]
      if (session !== sessionRef.current) return
      setErrors(previous => new Map(previous).set(gatekeeperId, message))
      toasts.add({ title: message, variant: 'error' })
    } finally {
      session.inFlight.delete(gatekeeperId)
      if (session === sessionRef.current) {
        setApplying(previous => {
          const next = new Set(previous)
          next.delete(gatekeeperId)
          return next
        })
      }
    }
  }

  return {
    status,
    pending,
    groups,
    unavailable,
    canEdit,
    blockedAutoApprovalConnections,
    setVeto,
    includeNewActions,
    applyBatch,
  }
}

/** The review controller: derived rows plus the draft operations Activity drives. */
export interface ActionReview {
  status: ActionsState['status']
  /** Every pending record, including the non-action ones this review does not batch. */
  pending: readonly ActionLogEntry[]
  groups: readonly ReviewGroup[]
  /** Pending actions with no connection to apply them through. */
  unavailable: readonly ReviewAction[]
  /** Whether drafts may be edited at all: connected, settled, and initialized. */
  canEdit: boolean
  /** Connections whose staged vetoes or in-flight batch must not be pre-empted by a new rule. */
  blockedAutoApprovalConnections: ReadonlyMap<WorkpieceId, AutoApprovalBlocker>
  setVeto(gatekeeperId: WorkpieceId, actionId: number, vetoed: boolean): void
  includeNewActions(gatekeeperId: WorkpieceId): void
  applyBatch(gatekeeperId: WorkpieceId): Promise<void>
}

/** Why enabling a new auto-approval rule on a connection would race the user's own review. */
export type AutoApprovalBlocker = 'applying' | 'vetoed'

export type ReviewAction = Extract<ActionLogEntry, { type: 'action' }>

export type ReviewGroup = {
  gatekeeperId: WorkpieceId
  resourceTitle: string
  resourceUrl?: string
  /** The reviewed boundary; absent until a brand-new connection's arrivals are included. */
  throughId?: number
  /** Included pending rows, oldest first, which Apply authorizes. */
  actions: readonly ReviewAction[]
  /** Pending rows that arrived after the boundary was frozen. */
  newActions: readonly ReviewAction[]
  /** Staged vetoes still pending and still included. */
  vetoIds: readonly number[]
  applying: boolean
  error?: string
}

/** Shown when a batch's outcome is not one of the recognized action refusals. */
export const UNKNOWN_BATCH_ERROR =
  'Couldn’t confirm the batch’s outcome. Check these actions before trying again.'

type Draft = { boundary: number; vetoes: ReadonlySet<number> }

type Bucket = { actions: ReviewAction[]; newActions: ReviewAction[]; newest: ReviewAction }

const NO_DRAFTS: ReadonlyMap<WorkpieceId, Draft> = new Map()
const NO_ERRORS: ReadonlyMap<WorkpieceId, string> = new Map()
const NO_CONNECTIONS: ReadonlySet<WorkpieceId> = new Set()
const NO_VETOES: ReadonlySet<number> = new Set()

const byId = (a: ReviewAction, b: ReviewAction) => a.id - b.id

const lowestPendingId = (group: ReviewGroup) =>
  Math.min(group.actions[0]?.id ?? Infinity, group.newActions[0]?.id ?? Infinity)

const without = (errors: ReadonlyMap<WorkpieceId, string>, gatekeeperId: WorkpieceId) => {
  if (!errors.has(gatekeeperId)) return errors
  const next = new Map(errors)
  next.delete(gatekeeperId)
  return next
}
