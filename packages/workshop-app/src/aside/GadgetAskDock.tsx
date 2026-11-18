import { useEffect, useState } from 'react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { GadgetAsk, type GadgetAskGroup } from '@/blocks/GadgetAsk'
import { useApproveCreation } from '@/connections/ApproveCreation'
import { useConnections } from '@/connections/useConnections'
import { askDetail, askGroups, askTitle, type Ask, type AskGroup } from '@/gadgets/askGroups'
import type { GadgetAsks } from '@/gadgets/GadgetAsks'
import { useGadgetAsks } from '@/gadgets/useGadgetAsks'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { AsideOutput } from './asideItems'

// How long what was allowed for good is said, once nothing else waits.
const NOTICE_MS = 8000

// Folded away for the visit, by gadget, so that it stays put away from one placement to another.
const foldedGadgets = new Set<string>()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type DockProps = {
  gadget: AsideOutput
  title: string
  /** The viewer builds in its workspace. */
  enabled: boolean
  /** It is shown beside the chat it is shown from, which asks what it asks from there. */
  chatInSight: boolean
  /** The workspace has read sensitive data. */
  restricted: boolean
  /** Something else floats over the foot of the pane (`PaneStatus`), which the dock stands above. */
  raised?: boolean
}

/**
 * What a gadget shown asks to do (`GadgetAsk`), docked over the foot of the pane, for whoever
 * builds in its workspace: beside a chat, as its own page and in full screen alike. Its code's
 * asks made outside any chat (while someone used it on its own page, or shared with them, or a
 * hook woke it), its agents', and, shown from a chat that is out of sight, that chat's through its
 * connections. Someone who only uses the gadget is shown nothing: the workspace tells them nothing
 * waits, and they cannot decide. What the services are, and how a creation is made, are read only
 * once it has asked something.
 */
export const GadgetAskDock = (props: DockProps) => {
  const { asks, ready, asked, agents, vendors } = useGadgetAsks(props.gadget, props)
  // Kept once it has asked, so that what was allowed is said after the last is decided.
  const [engaged, setEngaged] = useState(false)
  if (!engaged && asked.length > 0) setEngaged(true)
  if (!asks || !ready || !engaged) return null
  return <Dock {...props} asks={asks} asked={asked} agents={agents} vendors={vendors} />
}

/** The dock itself, once there is something to ask. A creation asks where it is made (`useApproveCreation`). */
const Dock = ({ gadget, title, restricted, raised, asks, asked, agents, vendors }: DockProps & {
  asks: GadgetAsks
  asked: Ask[]
  agents: ReadonlyMap<number, string | undefined>
  vendors: ReadonlyMap<number, string | undefined>
}) => {
  const connection = useConnectionNotice()
  const { state: connections } = useConnections()
  const { approveCreation, dialog } = useApproveCreation(gadget.workspaceId)
  const key = `${gadget.workspaceId}/${gadget.workpieceId}`
  const [folded, setFolded] = useState(() => foldedGadgets.has(key))
  const [problem, setProblem] = useState<string>()
  const [notice, setNotice] = useState<{ text: string; gatekeeperId: number; actionKind: ActionKind }>()

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const groups = askGroups(asked, { restricted })
  const serviceOf = (gatekeeperId?: number) => {
    const vendorId = gatekeeperId === undefined ? undefined : vendors.get(gatekeeperId)
    const vendor = vendorId && connections.status === 'ready' ? connections.connections.find((each) => each.vendorId === vendorId)?.vendor : undefined
    return vendor && { name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color }
  }
  const shown: GadgetAskGroup[] = groups.map((group) => ({
    key: group.key,
    title: askTitle(group),
    detail: askDetail(group, agents),
    service: serviceOf(group.gatekeeperId),
    allowable: group.allowable !== undefined,
    creation: group.creation,
    incomplete: group.asks.some(({ description }) => description.descriptionIsComplete !== true),
    requests: group.asks.map(({ id, description }) => ({ actionId: id, title: description.title, description: description.description, fields: description.fields ?? [] })),
  }))

  // Asks the workspace, unless the connection is down, which says so instead.
  const decide = (groupKey: string, decision: (group: AskGroup) => Promise<void>) => {
    if (connection?.blocked()) return
    const group = groups.find((each) => each.key === groupKey)
    if (!group) return
    setProblem(undefined)
    return decision(group).catch((error: unknown) => setProblem(`Couldn’t decide “${askTitle(group)}”: ${messageOf(error)}`))
  }
  const once = (group: AskGroup) => {
    const [first] = group.asks
    if (!group.creation || first.gatekeeperId === undefined) return asks.approve(group.asks)
    return approveCreation({ actionId: first.id, title: first.description.title, gatekeeperId: first.gatekeeperId })
  }
  const always = async ({ gatekeeperId, allowable, asks: kind }: AskGroup) => {
    if (gatekeeperId === undefined || !allowable) return asks.approve(kind)
    await asks.allow(gatekeeperId, allowable, kind)
    const where = kind[0].resourceTitle ? ` in ${kind[0].resourceTitle}` : ''
    setNotice({ text: `${allowable.label}${where} won’t be asked about again in this workspace.`, gatekeeperId, actionKind: allowable })
  }
  const undo = notice && (async () => {
    if (connection?.blocked()) return
    try {
      await asks.disallow(notice.gatekeeperId, notice.actionKind)
      setNotice(undefined)
    } catch (error) {
      setProblem(`Couldn’t take it back: ${messageOf(error)}`)
    }
  })

  return (
    <>
      <div
        data-raised={raised ? '' : undefined}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-[min(32rem,75%)] justify-center px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] data-raised:pb-[calc(var(--control-size)+1.75rem)]"
      >
        <div className="flex max-h-full w-full max-w-xl">
          <GadgetAsk
            gadgetTitle={title}
            groups={shown}
            restricted={restricted}
            folded={folded}
            onFoldedChange={(fold) => {
              if (fold) foldedGadgets.add(key)
              else foldedGadgets.delete(key)
              setFolded(fold)
            }}
            notice={notice && undo ? { text: notice.text, action: { label: 'Undo', onClick: undo } } : undefined}
            problem={problem}
            onDismissProblem={() => setProblem(undefined)}
            onAllow={(groupKey) => decide(groupKey, always)}
            onAllowOnce={(groupKey) => decide(groupKey, once)}
            onDeny={(groupKey) => decide(groupKey, (group) => asks.deny(group.asks))}
          />
        </div>
      </div>
      {dialog}
    </>
  )
}
