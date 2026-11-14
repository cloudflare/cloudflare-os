import { BindingRow } from '@/blocks/BindingRow'
import { ListGroup } from '@/blocks/ListGroup'
import { useServices } from '@/connections/useServices'
import { useChatConnections } from './useChatConnections'

const GROUPS = [
  { scope: 'chat', label: 'In this chat' },
  { scope: 'workspace', label: 'From the workspace’s gadgets' },
  { scope: 'always', label: 'Always there' },
] as const

/**
 * What a chat's agent can use, a group each: what was added in the chat, or read or changed
 * through in it; what the workspace's gadgets hold; and what every chat has. Each with its
 * service's logo and the name the agent knows it by, with the way to where its account is managed.
 * More is added from the composer's + menu.
 */
export const ChatConnectionList = ({ workspaceId, chatId, onManage }: { workspaceId: string; chatId: number; onManage: () => void }) => {
  const state = useChatConnections(workspaceId, chatId)
  const { services } = useServices()
  const serviceOf = (vendorId: string | undefined) => {
    const vendor = vendorId === undefined || services.status !== 'ready' ? undefined : services.vendors.find(({ id }) => id === vendorId)
    return vendor && { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, color: vendor.description.color }
  }

  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading its connections…</p>
  if (state.status === 'failed') return <p role="alert" className="px-4 text-center text-base text-kumo-danger">Couldn’t load its connections. {state.message}</p>
  return (
    <div className="flex flex-col gap-6">
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
                {rows.map((each) => (
                  <BindingRow
                    key={each.gatekeeperId}
                    name={each.name}
                    resource={each.title}
                    service={serviceOf(each.vendorId)}
                    onManage={each.vendorId ? onManage : undefined}
                  />
                ))}
              </ListGroup>
            )}
          </section>
        )
      })}
    </div>
  )
}
