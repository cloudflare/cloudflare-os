import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { GadgetAsk, type GadgetAskGroup } from '@/blocks/GadgetAsk'
import { usePendingDecisions, type Decision } from '@/chat/usePendingDecisions'
import { useApproveCreation } from '@/connections/ApproveCreation'
import { useServices } from '@/connections/useServices'
import { connectedFileIdOfUrl, connectedKindOfUrl } from '@/files/connectedFile'
import type { GadgetAgent, GadgetRequest } from '@/gadgets/GadgetRequests'
import { useGadgetRequests } from '@/gadgets/useGadgetRequests'
import { useWaiting } from '@/library/WaitingProvider'
import { formatActivity } from '@/workspaces/formatActivity'
import type { AsideOutput } from './asideItems'
import { GadgetFileReview, type ReviewedFile } from './GadgetFileReview'

// How long the Library's index takes to hear of a change to what waits.
const INDEX_MS = 1500
// How long what was allowed is said, once nothing else waits.
const NOTICE_MS = 6000
// Older than this, a request says when it was made: it was made while the viewer was elsewhere.
const AWAY_MS = 2 * 60_000

type Kinded = { key: string; requests: GadgetRequest[] }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The gadget's requests by connection and kind, in the order the first of each was made. */
const byKind = (waiting: readonly GadgetRequest[]): Kinded[] => {
  const groups = new Map<string, GadgetRequest[]>()
  for (const request of waiting) {
    const tag = request.description.actionKind?.tag
    // One with no kind can only be decided on its own.
    const key = tag !== undefined ? `${request.gatekeeperId}:${tag}` : `action:${request.id}`
    groups.set(key, [...(groups.get(key) ?? []), request])
  }
  return [...groups].map(([key, requests]) => ({ key, requests }))
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** The file a request changes, when it is one that can be drawn as it will be, such as a Google Doc. */
const fileOf = (request: GadgetRequest, workspaceId: string): ReviewedFile | undefined => {
  const { gatekeeperId, resourceUrl, resourceTitle } = request
  if (gatekeeperId === undefined || !resourceUrl) return undefined
  const kind = connectedKindOfUrl(resourceUrl)
  const subjectId = connectedFileIdOfUrl(resourceUrl)
  return kind && subjectId ? { workspaceId, gatekeeperId, subjectId, kind, url: resourceUrl, title: resourceTitle ?? 'File' } : undefined
}

// The agent the gadget started that asks for all of them, when one does.
const agentOf = (requests: readonly GadgetRequest[], agents: ReadonlyMap<number, GadgetAgent>) => {
  const [first] = requests
  const agent = first.chatId === undefined ? undefined : agents.get(first.chatId)
  return agent && requests.every(({ chatId }) => chatId !== undefined && agents.get(chatId)?.name === agent.name) ? agent : undefined
}

// Whose they are when an agent asks, where (unless it is said already, as over the file itself),
// how many, and since when.
const detailOf = (requests: readonly GadgetRequest[], now: Date, agent?: GadgetAgent, where = true) => {
  const first = requests[0]
  const parts = [
    agent ? `From ${agent.name ?? 'its agent'}` : undefined,
    where ? first.resourceTitle : undefined,
    requests.length > 1 ? `${requests.length} changes` : where ? undefined : '1 change',
    now.getTime() - first.createdAt.getTime() > AWAY_MS ? `since ${lowerFirst(formatActivity(first.createdAt, now))}` : undefined,
  ]
  return parts.filter(Boolean).join(' · ')
}

/**
 * What the gadget shown as its own page asks to change, docked over its foot (`GadgetAsk`), for
 * whoever builds in its workspace; not for someone who only uses it, who cannot decide them. What
 * its own code asks, and the agents it started, which act for it and say so; not what the chat it
 * is shown from asks, which is that chat's. Changes to a Google file are reviewed on the file,
 * drawn over the gadget (`GadgetFileReview`).
 */
export const GadgetAskDock = ({ gadget, title, onOpenSettings }: {
  gadget: AsideOutput
  title: string
  /** Goes to its settings, where what it may do can be taken back. */
  onOpenSettings?: () => void
}) => {
  const { requests, snapshot } = useGadgetRequests(gadget)
  const { services } = useServices()
  const [problem, setProblem] = useState<string>()
  // Decided as a chat's are: in order, and a creation made in one of the user's accounts, asking
  // which in `dialog` when there is a choice.
  const decideOne = useCallback((actionId: number, decision: Decision) =>
    requests ? requests.decide(actionId, decision) : Promise.reject(new Error('The gadget is still loading.')), [requests])
  const { approveCreation, dialog } = useApproveCreation({
    workspaceId: gadget.workspaceId,
    approve: (actionId, creation) => requests ? requests.decide(actionId, 'approve', creation) : Promise.reject(new Error('The gadget is still loading.')),
  })
  const decisions = usePendingDecisions({ decide: decideOne, approveCreation })
  const [notice, setNotice] = useState<string>()
  // The connection whose file is being reviewed over the gadget.
  const [reviewing, setReviewing] = useState<number>()
  const closeReview = useCallback(() => setReviewing(undefined), [])

  // What waits here changed, so the count across every gadget is read again, once the Library's
  // index has caught up with it.
  const { refresh } = useWaiting()
  const count = snapshot.waiting.length
  const seen = useRef(count)
  useEffect(() => {
    if (seen.current === count) return
    seen.current = count
    const timer = setTimeout(refresh, INDEX_MS)
    return () => clearTimeout(timer)
  }, [count, refresh])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // Everything waiting on the file under review, whatever its kind, as the file draws them all.
  const onFile = reviewing === undefined ? [] : snapshot.waiting.filter(({ gatekeeperId }) => gatekeeperId === reviewing)
  const [reviewed] = onFile
  // Kept while its last change settles, then gone.
  const [file, setFile] = useState<ReviewedFile>()
  useEffect(() => {
    if (reviewing === undefined) setFile(undefined)
    else if (reviewed) setFile((current) => (current?.gatekeeperId === reviewing ? current : fileOf(reviewed, gadget.workspaceId)))
  }, [reviewing, reviewed, gadget.workspaceId])

  if (!requests) return null
  const now = new Date()
  const kinds = byKind(snapshot.waiting)
  const vendorOf = (gatekeeperId?: number) => {
    const vendorId = gatekeeperId === undefined ? undefined : snapshot.vendors.get(gatekeeperId)
    const vendor = vendorId && services.status === 'ready' ? services.vendors.find(({ id }) => id === vendorId) : undefined
    return vendor && { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, color: vendor.description.color }
  }
  const groups: GadgetAskGroup[] = kinds.map(({ key, requests: kind }) => {
    const { description, gatekeeperId } = kind[0]
    return {
      key,
      title: description.actionKind?.label ?? description.title,
      detail: detailOf(kind, now, agentOf(kind, snapshot.agents)),
      service: vendorOf(gatekeeperId),
      allowable: description.autoApprovable && description.actionKind !== undefined && gatekeeperId !== undefined,
      requests: kind.map(({ id, description: each }) => ({ actionId: id, title: each.title, description: each.description, fields: each.fields ?? [] })),
      onReview: gatekeeperId !== undefined && fileOf(kind[0], gadget.workspaceId) ? () => setReviewing(gatekeeperId) : undefined,
    }
  })
  // What it is allowed, it and its agents may do.
  const allowed = (actionKind: ActionKind) => setNotice(`${title}${snapshot.agents.size > 0 ? ' and its agents' : ''} can ${lowerFirst(actionKind.label)} without asking now.`)

  const decide = (key: string, decision: Decision) => {
    const kind = kinds.find((each) => each.key === key)
    if (!kind) return
    setProblem(undefined)
    return decisions.run(kind.requests.map(({ id, description, creation, gatekeeperId }) => ({
      actionId: id,
      title: description.title,
      creation: creation && gatekeeperId !== undefined ? { gatekeeperId } : undefined,
    })), decision)
  }

  return (
    <>
    <AnimatePresence>
      {file && (
        <GadgetFileReview
          key={file.gatekeeperId}
          file={file}
          gadgetTitle={title}
          waiting={onFile}
          detail={onFile.length > 0 ? `${agentOf(onFile, snapshot.agents) ? '' : `From ${title} · `}${detailOf(onFile, now, agentOf(onFile, snapshot.agents), false)}` : 'Nothing waits'}
          service={vendorOf(file.gatekeeperId)}
          requests={requests}
          onClose={closeReview}
          onAllowed={(actionKind) => {
            allowed(actionKind)
            closeReview()
          }}
        />
      )}
    </AnimatePresence>
    {dialog}
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-3">
      <div className="w-full max-w-xl">
        <GadgetAsk
          gadgetTitle={title}
          madeBy={snapshot.gadget?.publishedBy?.name}
          // The file under review takes the gadget's place, and is decided there.
          groups={file ? [] : groups}
          notice={notice ? { text: notice, action: onOpenSettings && { label: 'Settings', onClick: onOpenSettings } } : undefined}
          problem={problem ?? decisions.problem}
          onDismissProblem={() => {
            setProblem(undefined)
            decisions.dismissProblem()
          }}
          onAllow={async (key) => {
            const kind = kinds.find((each) => each.key === key)
            if (!kind) return
            const { gatekeeperId, description } = kind.requests[0]
            if (gatekeeperId === undefined || !description.actionKind) return decide(key, 'approve')
            setProblem(undefined)
            try {
              await requests.allow(gatekeeperId, description.actionKind)
              allowed(description.actionKind)
            } catch (error) {
              setProblem(`Couldn’t allow “${description.actionKind.label}”: ${messageOf(error)}`)
            }
          }}
          onAllowOnce={(key) => decide(key, 'approve')}
          onDeny={(key) => decide(key, 'deny')}
        />
      </div>
    </div>
    </>
  )
}
