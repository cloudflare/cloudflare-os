import { Button } from '@/components/Button'
import { ListGroup } from '@/blocks/ListGroup'
import { WorkspaceConnectionRow } from '@/blocks/WorkspaceConnectionRow'
import { ConnectionDetails, type ConnectionLinks } from '@/connections/ConnectionDetails'
import { useConnectionServices, useWorkspaceConnections } from '@/connections/useWorkspaceConnections'
import { automaticLine, connectionGroups, kindOf, usesLine } from '@/connections/workspaceConnections'
import { useWorkspaceGadgets } from '@/gadgets/useWorkspaceGadgets'
import { useChatThreads, useWorkspaces } from './WorkspacesContext'

export type WorkspaceConnectionListProps = {
  workspaceId: string
  /** The connection open in its dialog, if one is. */
  open?: number
  onOpenChange: (gatekeeperId: number | undefined) => void
  links: ConnectionLinks
}

/**
 * Everything a workspace's chats and gadgets can reach, by service, then what every chat has: each
 * connection with what it is, what uses it, and what goes ahead through it without asking, opening
 * its dialog (`ConnectionDetails`), where that is chosen for the whole workspace. Whatever it is
 * reached from, a change through it asks first unless the workspace makes it automatic, which the
 * list says above it, or that everything asks, once the workspace has read restricted data.
 */
export const WorkspaceConnectionList = ({ workspaceId, open, onOpenChange, links }: WorkspaceConnectionListProps) => {
  const connections = useWorkspaceConnections(workspaceId)
  const services = useConnectionServices()
  const gadgets = useWorkspaceGadgets(workspaceId)
  const workspaces = useWorkspaces()
  const threads = useChatThreads()
  // Which of its chats are an agent's runs, and whose: an agent is named once, not counted as chats.
  const agentOf = new Map(threads?.flatMap(({ workspaceId: id, chatId, spawnerName }) => (id === workspaceId && spawnerName ? [[chatId, spawnerName] as const] : [])))
  const restricted = workspaces.status === 'ready' && workspaces.workspaces.some(({ id, containsRestrictedData }) => id === workspaceId && containsRestrictedData)
  const { state } = connections

  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading its connections…</p>
  if (state.status === 'failed') {
    return (
      <p role="alert" className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
        Couldn’t load its connections: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }
  const groups = connectionGroups(state.connections, services)
  return (
    <div className="appears flex flex-col gap-6">
      <p className="max-w-xl px-4 text-base/6 text-pretty text-kumo-default">
        {restricted
          ? 'What this workspace’s chats and gadgets can reach. It has read restricted data, so every change through them asks first.'
          : 'What this workspace’s chats and gadgets can reach. Reading never asks. A change asks first, unless you make that kind of change automatic here.'}
      </p>
      {groups.length === 0 && (
        <p className="px-4 text-base text-pretty text-kumo-subtle">
          Nothing is connected yet. Add a repository, a spreadsheet or a mailbox from the + in a chat’s message box or from a gadget’s Connections, or ask the agent to connect one.
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">{group.label}</h2>
          <ListGroup label={group.label}>
            {group.connections.map((connection) => {
              const service = services.get(connection.vendorId)
              const resource = service?.resources.find(({ urlPattern }) => urlPattern === connection.typeUrlPattern)
              const names = gadgets && connection.gadgetIds.flatMap((id) => gadgets.get(id)?.title ?? [])
              const agents = [...new Set(connection.chatIds.flatMap((id) => agentOf.get(id) ?? []))]
              const chats = connection.chatIds.filter((id) => !agentOf.has(id)).length
              return (
                <WorkspaceConnectionRow
                  key={connection.gatekeeperId}
                  title={connection.title}
                  detail={[connection.ambient ? undefined : kindOf(connection, services), usesLine(names ?? connection.gadgetIds.length, chats, agents)].filter(Boolean).join(' · ')}
                  logo={{ name: service?.name ?? connection.title, src: resource?.icon?.url ?? service?.logoUrl, color: service?.color }}
                  // Nothing goes ahead unasked where everything asks.
                  automatic={restricted ? undefined : automaticLine(state.automatic.get(connection.gatekeeperId) ?? [])}
                  onOpen={() => onOpenChange(connection.gatekeeperId)}
                />
              )
            })}
          </ListGroup>
        </section>
      ))}
      <ConnectionDetails
        workspaceId={workspaceId}
        gatekeeperId={open}
        onClose={() => onOpenChange(undefined)}
        connections={connections}
        links={links}
        gadgets={gadgets}
      />
    </div>
  )
}
