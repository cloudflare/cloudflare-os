import { useState } from 'react'
import { ChatCircleIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkspaceConnectionInfo } from '@gadgets/workshop-shared/api'
import { ConnectionDetailsDialog, type ConnectionUse } from '@/blocks/ConnectionDetailsDialog'
import { FormatIcon } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { KindMark } from '@/components/KindMark'
import { useGadgetColor } from '@/gadgets/useGadgetColor'
import { useWorkspaceGadgets } from '@/gadgets/useWorkspaceGadgets'
import { useApi } from '@/rpc/ApiContext'
import { useChatThreads, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useConnectionServices, type WorkspaceConnections } from './useWorkspaceConnections'
import { changesOf, kindOf, type ConnectionServices } from './workspaceConnections'

/** Somewhere to go from a connection, as a link: an address to open in another tab, and the way there in place. */
export type ConnectionPlace = { href?: string; onOpen: () => void }

/** Where a connection's dialog goes: what uses it, the account it goes through, and the workspace's every connection. */
export type ConnectionLinks = {
  /** A gadget's connections, or a chat. */
  use: (workspaceId: string, use: { type: 'gadget'; gadgetId: number } | { type: 'chat'; chatId: number; title: string }) => ConnectionPlace
  /** The page of the user's account on a service: its own, with one, else the Gatekeepers page. */
  account: (vendorId: string) => ConnectionPlace
  /** The workspace's Connections tab, with one of them open if given. */
  workspace: (workspaceId: string, gatekeeperId?: number) => ConnectionPlace
}

/**
 * The way from a page that shows some of a workspace's connections, a chat's or a gadget's, to all
 * of them: the last words of the line under the list, "…allow them in the workspace's connections."
 */
export const WorkspaceConnectionsLink = ({ href, onOpen }: ConnectionPlace) => (
  <LinkButton
    href={href}
    onClick={onOpen}
    className="rounded-sm font-medium whitespace-nowrap text-kumo-default underline-offset-2 outline-none hover:underline focus-visible:underline"
  >
    workspace’s connections
  </LinkButton>
)

// A gadget's mark, in the colour chosen for it on its page.
const GadgetIcon = ({ workspaceId, gadget }: { workspaceId: string; gadget: GadgetSummary }) => (
  <FormatIcon name={gadget.output?.icon} color={useGadgetColor(workspaceId, gadget.id)} />
)

/** Where in its service a connection is, when it has an address of its own rather than a pattern. */
const serviceLinkOf = (connection: WorkspaceConnectionInfo, services: ConnectionServices) => {
  const url = connection.resourceUrl
  if (!url || !/^https:\/\/[^*]+$/.test(url) || /\/:[a-z]/i.test(url)) return undefined
  return { label: `Open in ${services.get(connection.vendorId)?.name ?? 'its service'}`, href: url }
}

export type ConnectionDetailsProps = {
  workspaceId: string
  /** The connection shown; none, and it is closed. */
  gatekeeperId: number | undefined
  onClose: () => void
  /** The workspace's connections and what goes ahead through them, as the page showing them read them. */
  connections: WorkspaceConnections
  links: ConnectionLinks
  /** From a page that shows only some of them: offers the rest, in the workspace. */
  seeAll?: boolean
  /** The workspace's gadgets, where the page has them already; otherwise they are listed while it is open. */
  gadgets?: ReadonlyMap<number, GadgetSummary>
}

/**
 * One of a workspace's connections, in its dialog (`ConnectionDetailsDialog`): what uses it, from
 * the workspace's gadgets and the user's chats in it, an agent once however many of its runs did, and every kind of change it can make, for the
 * workspace's rules to make automatic or ask first. Each gadget made from someone else's blueprint
 * says that it asks anyway, as a workspace's rules never cover code its owner did not write.
 * Everything asks in a workspace that has read restricted data, and only whoever builds in it may
 * choose.
 */
export const ConnectionDetails = ({ workspaceId, gatekeeperId, onClose, connections, links, seeAll, gadgets: given }: ConnectionDetailsProps) => {
  const { user } = useApi()
  const services = useConnectionServices()
  const workspaces = useWorkspaces()
  const threads = useChatThreads()
  // Kept as it closes, so that it closes as it was.
  const [shown, setShown] = useState(gatekeeperId)
  if (gatekeeperId !== undefined && gatekeeperId !== shown) setShown(gatekeeperId)
  const listed = useWorkspaceGadgets(workspaceId, shown !== undefined && !given)
  const gadgets = given ?? listed

  const ready = connections.state.status === 'ready' ? connections.state : undefined
  const connection = ready?.connections.find((each) => each.gatekeeperId === shown)
  if (!connection) return null
  const service = services.get(connection.vendorId)
  const resource = service?.resources.find(({ urlPattern }) => urlPattern === connection.typeUrlPattern)
  const automatic = ready?.automatic.get(connection.gatekeeperId) ?? []
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined

  const gadgetUses = gadgets && connection.gadgetIds.flatMap((id): ConnectionUse[] => {
    const gadget = gadgets.get(id)
    if (!gadget) return []
    const madeBy = gadget.publishedBy && gadget.publishedBy.id !== user.id ? gadget.publishedBy.name : undefined
    return [{
      key: `gadget:${id}`,
      icon: <GadgetIcon workspaceId={workspaceId} gadget={gadget} />,
      title: gadget.title,
      detail: madeBy ? `Made by ${madeBy}, so it asks separately` : 'Gadget',
      ...links.use(workspaceId, { type: 'gadget', gadgetId: id }),
    }]
  })
  const used = threads
    ?.filter((thread) => thread.workspaceId === workspaceId && connection.chatIds.includes(thread.chatId))
    .toSorted((a, b) => (b.latestActivityAt?.getTime() ?? 0) - (a.latestActivityAt?.getTime() ?? 0))
  // An agent once, however many of its runs used it, opening the latest; its runs are not chats.
  const runs = new Map<string, NonNullable<typeof used>>()
  for (const thread of used ?? []) {
    if (thread.spawnerName) runs.set(thread.spawnerName, [...runs.get(thread.spawnerName) ?? [], thread])
  }
  const agentUses = [...runs].map(([name, [latest, ...rest]]): ConnectionUse => ({
    key: `agent:${name}`,
    icon: <KindMark name="agent" />,
    title: name,
    detail: rest.length ? `Agent · ${rest.length + 1} runs` : 'Agent · 1 run',
    ...links.use(workspaceId, { type: 'chat', chatId: latest!.chatId, title: latest!.chatTitle }),
  }))
  const chatUses = used?.filter(({ spawnerName }) => !spawnerName).map((thread): ConnectionUse => ({
    key: `chat:${thread.chatId}`,
    icon: <ChatCircleIcon className="size-5 text-kumo-default" />,
    title: thread.chatTitle,
    detail: 'Chat',
    ...links.use(workspaceId, { type: 'chat', chatId: thread.chatId, title: thread.chatTitle }),
  }))
  const uses = gadgetUses && chatUses && [...gadgetUses, ...agentUses, ...chatUses]

  const builds = workspace !== undefined && workspace.role !== 'use'
  const locked = workspace?.containsRestrictedData
    ? 'This workspace contains restricted data, so every change asks you first.'
    : builds ? undefined : 'Only people who can build in this workspace can change these.'

  return (
    <ConnectionDetailsDialog
      open={gatekeeperId !== undefined}
      onOpenChange={(open) => { if (!open) onClose() }}
      onClosed={() => setShown(undefined)}
      title={connection.title}
      logo={{ name: service?.name ?? connection.title, src: resource?.icon?.url ?? service?.logoUrl, color: service?.color }}
      kind={connection.ambient ? `Every chat has ${service?.name ?? 'it'}` : kindOf(connection, services)}
      serviceLink={serviceLinkOf(connection, services)}
      uses={uses}
      changes={changesOf(connection, service?.resources ?? [], automatic)}
      onChange={(kind, on) => connections.change(connection.gatekeeperId, kind, on)}
      locked={locked}
      problem={connections.problem}
      // Every chat has it from the deployment, with no account of the user's to manage.
      account={connection.ambient ? undefined : { label: `${service?.name ?? 'Its'} account`, ...links.account(connection.vendorId) }}
      onSeeAll={seeAll ? links.workspace(workspaceId, connection.gatekeeperId).onOpen : undefined}
    />
  )
}
