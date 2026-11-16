import { useState } from 'react'
import { BindingRow } from '@/blocks/BindingRow'
import { ListGroup } from '@/blocks/ListGroup'
import { ConnectionDetails, WorkspaceConnectionsLink, type ConnectionLinks } from '@/connections/ConnectionDetails'
import { useConnectionServices, useWorkspaceConnections } from '@/connections/useWorkspaceConnections'
import { automaticLine } from '@/connections/workspaceConnections'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useChatConnections } from './useChatConnections'

const GROUPS = [
  { scope: 'chat', label: 'In this chat' },
  { scope: 'workspace', label: 'From the workspace’s gadgets' },
  { scope: 'always', label: 'Always there' },
] as const

/**
 * What a chat's agent can use, a group each: what was added in the chat, or read or changed
 * through in it; what the workspace's gadgets hold; and what every chat has. Each with its
 * service's logo, the name the agent knows it by and what goes ahead through it without asking,
 * which its More opens in the connection's dialog (`ConnectionDetails`), where the workspace
 * chooses that, as the line under the list says, with the way to the workspace's every connection
 * for a named one. More is added from the composer's + menu.
 */
export const ChatConnectionList = ({ workspaceId, chatId, links }: { workspaceId: string; chatId: number; links: ConnectionLinks }) => {
  const state = useChatConnections(workspaceId, chatId)
  const connections = useWorkspaceConnections(workspaceId)
  const services = useConnectionServices()
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const [open, setOpen] = useState<number>()
  const automatic = connections.state.status === 'ready' && !workspace?.containsRestrictedData ? connections.state.automatic : undefined
  const named = isNamedWorkspace(workspace)

  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading its connections…</p>
  if (state.status === 'failed') return <p role="alert" className="px-4 text-center text-base text-kumo-danger">Couldn’t load its connections. {state.message}</p>
  return (
    <div className="appears flex flex-col gap-6">
      {GROUPS.map(({ scope, label }) => {
        const rows = state.connections.filter((each) => each.scope === scope)
        if (rows.length === 0 && scope !== 'chat') return null
        return (
          <section key={scope} className="flex flex-col gap-2">
            <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
            {rows.length === 0 ? (
              <p className="px-4 text-base text-pretty text-kumo-subtle">Nothing yet. Add a repository, a spreadsheet or a mailbox from the + in the chat’s message box, and it goes with your next message.</p>
            ) : (
              <ListGroup label={label}>
                {rows.map((each) => {
                  const service = each.vendorId === undefined ? undefined : services.get(each.vendorId)
                  return (
                    <BindingRow
                      key={each.gatekeeperId}
                      name={each.name}
                      resource={each.title}
                      service={service && { name: service.name, logoUrl: service.logoUrl, color: service.color }}
                      automatic={automatic && automaticLine(automatic.get(each.gatekeeperId) ?? [])}
                      // A connection to a service; an agent spawner has a page of its own.
                      onManage={each.vendorId ? () => setOpen(each.gatekeeperId) : undefined}
                    />
                  )
                })}
              </ListGroup>
            )}
          </section>
        )
      })}
      <p className="px-4 text-sm/5 text-pretty text-kumo-subtle">
        {workspace?.containsRestrictedData
          ? 'This workspace contains restricted data, so the chat asks you before every change.'
          : <>
              This chat asks you before it changes anything, like editing a doc or sending an email.{' '}
              {named
                ? <>To let some changes through, allow them in the <WorkspaceConnectionsLink {...links.workspace(workspaceId)} />.</>
                : 'When it asks, Always allow lets that kind of change through next time.'}
            </>}
      </p>
      <ConnectionDetails workspaceId={workspaceId} gatekeeperId={open} onClose={() => setOpen(undefined)} connections={connections} links={links} seeAll={named} />
    </div>
  )
}
