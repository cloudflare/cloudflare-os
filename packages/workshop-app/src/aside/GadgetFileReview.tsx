import { useEffect, useMemo, useState } from 'react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedFileReview } from '@/blocks/ConnectedFileView'
import { GadgetReview } from '@/blocks/GadgetReview'
import type { ChangeDecision } from '@/blocks/resource-preview/changeMarks'
import type { DecisionProgress } from '@/chat/usePendingDecisions'
import { OPEN_IN, type ConnectedFileKind } from '@/files/connectedFile'
import type { GadgetRequest, GadgetRequests } from '@/gadgets/GadgetRequests'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { AsideConnectedFile } from './asideItems'
import { ConnectedContent } from './ConnectedContent'
import { useConnectedFilePreview } from './useConnectedFilePreview'

/** A file a gadget's changes go to, which can be drawn as it will be. */
export type ReviewedFile = {
  workspaceId: string
  gatekeeperId: number
  /** The service's id for it, from where it opens. */
  subjectId: string
  kind: ConnectedFileKind
  url: string
  title: string
}

export type GadgetFileReviewProps = {
  file: ReviewedFile
  gadgetTitle: string
  /** Its changes waiting, as `GadgetRequests` has them, oldest first. */
  waiting: readonly GadgetRequest[]
  detail: string
  service?: { name: string; logoUrl?: string; color?: string }
  requests: GadgetRequests
  /** Back to the gadget: Back, Escape, or once nothing on the file waits. */
  onClose: () => void
  /** The kind was allowed for good, as Always allow does from the ask. */
  onAllowed: (actionKind: ActionKind) => void
}

// How long the last change decided is shown settled before going back to the gadget.
const SETTLE_MS = 700

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The changes a gadget asks to make to a file, reviewed on the file (`GadgetReview`), as the chat
 * reviews its own beside it: the file read through the gadget's connection, drawn with every
 * change waiting on it, stepped through one at a time, each decided through the gadget's requests
 * in the order the connection applies them. Always allow lets the gadget make their kind of change
 * without asking from now on, where they are all of one kind its service allows that for. Goes
 * back to the gadget once nothing waits on the file.
 */
export const GadgetFileReview = ({ file, gadgetTitle, waiting, detail, service, requests, onClose, onAllowed }: GadgetFileReviewProps) => {
  const workspaces = useWorkspaces()
  const [decided, setDecided] = useState<ReadonlyMap<number, ChangeDecision>>(new Map())
  const [progress, setProgress] = useState<DecisionProgress>()
  const [problem, setProblem] = useState<string>()

  const shown = useMemo((): AsideConnectedFile => ({
    workspaceId: file.workspaceId,
    gatekeeperId: file.gatekeeperId,
    subjectId: file.subjectId,
    fileKind: file.kind,
    url: file.url,
  }), [file])
  // Drawn again whenever what waits on it changes, such as one decided here.
  const state = useConnectedFilePreview(shown, waiting.map(({ id }) => id).join(','))

  const empty = waiting.length === 0
  useEffect(() => {
    if (!empty) return
    const timer = setTimeout(onClose, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [empty, onClose])

  // One kind its service lets go ahead unasked, so that allowing it covers all of them.
  const kinds = new Set(waiting.map(({ description }) => description.actionKind?.tag))
  const first = waiting[0]?.description
  const allowable = kinds.size === 1 && first?.actionKind !== undefined && waiting.every(({ description }) => description.autoApprovable)
    ? first.actionKind
    : undefined

  const decide = async (ids: readonly number[], decision: 'approve' | 'deny') => {
    // Approved oldest first, so an edit never lands before the one it builds on; denied newest first.
    const chosen = waiting
      .filter(({ id }) => ids.includes(id))
      .toSorted((a, b) => (decision === 'approve' ? a.id - b.id : b.id - a.id))
    setProblem(undefined)
    try {
      for (const [done, request] of chosen.entries()) {
        if (chosen.length > 1) setProgress({ verb: decision === 'approve' ? 'Approving' : 'Denying', done, total: chosen.length })
        try {
          await requests.decide(request.id, decision)
        } catch (error) {
          setProblem(`Couldn’t ${decision} “${request.description.title}”: ${messageOf(error)}`)
          return
        }
        setDecided((current) => new Map(current).set(request.id, decision === 'approve' ? 'approved' : 'rejected'))
      }
    } finally {
      setProgress(undefined)
    }
  }

  const review: ConnectedFileReview = {
    changes: waiting.map(({ id, description }) => ({ actionId: id, title: description.title, description: description.description, fields: description.fields ?? [] })),
    decided,
    onDecide: decide,
    restricted: workspaces.status === 'ready' && workspaces.workspaces.find(({ id }) => id === file.workspaceId)?.containsRestrictedData === true,
    progress,
    problem,
    onDismissProblem: () => setProblem(undefined),
  }

  return (
    <GadgetReview
      gadgetTitle={gadgetTitle}
      title={file.title}
      detail={detail}
      service={service}
      openIn={{ label: OPEN_IN[file.kind], href: file.url }}
      onAlwaysAllow={allowable ? async () => {
        setProblem(undefined)
        try {
          await requests.allow(file.gatekeeperId, allowable)
          onAllowed(allowable)
        } catch (error) {
          setProblem(`Couldn’t allow it: ${messageOf(error)}`)
        }
      } : undefined}
      onClose={onClose}
    >
      <ConnectedContent title={file.title} kind={file.kind} state={state} review={review} />
    </GadgetReview>
  )
}
