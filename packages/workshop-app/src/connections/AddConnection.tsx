import { memo, useMemo, useState } from 'react'
import type { RpcPromise } from 'capnweb'
import type { GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ResourceDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { AddConnectionDialog, type ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { useApi } from '@/rpc/ApiContext'
import { resourceGroups, resourceOfUrl } from './connectionList'
import { ConnectResource } from './SetUpConnection'
import { useConnections } from './useConnections'

/** A connection just made in a workspace (`newGatekeeper`), as much of it as is shown. */
export type AddedConnection = {
  gatekeeperId: number
  description: ResourceDescription
  vendorId: string
  service: { name: string; logoUrl?: string; color?: string }
  /** What kind of resource it is, as its service names it: "Repository". */
  kind: string
}

export type AddConnectionProps = {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is added to, as the dialogs say it: "this chat". */
  to: string
  /** Hands the connection to what it was added for; the dialogs close once it resolves. */
  onAdded: (connection: AddedConnection) => Promise<void>
}

type Chosen = ConnectionChoice & {
  vendorId: string
  urlPattern: string
  /** The kinds its form may choose among, when it stands for more than one (`groupedWith`). */
  kinds: SupportedResource[]
}

/**
 * Adds a connection to a chat, as the user chose rather than an agent asked: what to connect
 * (`AddConnectionDialog`), from every kind of resource of the services that can be connected,
 * those the user has an account on first; then which one, in that service's own form
 * (`ConnectResource`), making it in the workspace (`newGatekeeper`) and handing it over. Drawn
 * again only for props of its own, not with the chat it is in as each word of a reply comes: a
 * stable `onAdded` keeps it so.
 */
export const AddConnection = memo(function AddConnection({ workspaceId, open, onOpenChange, to, onAdded }: AddConnectionProps) {
  const { api } = useApi()
  const { state } = useConnections()
  const [chosen, setChosen] = useState<Chosen>()

  const choices = useMemo((): Chosen[] | undefined => {
    if (state.status !== 'ready') return undefined
    const mine = new Set(state.connections.flatMap((each) => (each.kind === 'account' ? [each.vendorId] : [])))
    // A service once, whether it is listed for an account on it or to be connected.
    const services = new Map(state.connections.map((each) => [each.vendorId, each]))
    return [...services.values()]
      // Those the deployment provides come with every chat already.
      .filter(({ vendor }) => !vendor.autoProvisionsAccount)
      // A choice per group of kinds: Google Drive, rather than its folders, files and Docs apart.
      .flatMap(({ vendorId, vendor, resources }) => resourceGroups(resources).map(({ lead, members }): Chosen => ({
        key: `${vendorId} ${lead.urlPattern}`,
        vendorId,
        urlPattern: lead.urlPattern,
        kinds: members,
        service: { name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color },
        title: lead.title,
        description: lead.description,
        connected: mine.has(vendorId),
      })))
      .toSorted((a, b) => a.service.name.localeCompare(b.service.name) || a.title.localeCompare(b.title))
  }, [state])

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) setChosen(undefined)
  }

  return (
    <>
      <AddConnectionDialog
        open={open && !chosen}
        onOpenChange={close}
        to={to}
        choices={choices}
        problem={state.status === 'failed' ? `Couldn’t read your services: ${state.message}` : undefined}
        onChoose={(choice) => setChosen(choices?.find(({ key }) => key === choice.key))}
      />
      {chosen && (
        <ConnectResource
          // Each kind starts its form afresh.
          key={chosen.key}
          open={open}
          onOpenChange={close}
          vendorId={chosen.vendorId}
          name={chosen.service.name}
          logoUrl={chosen.service.logoUrl}
          resourceUrlPattern={chosen.urlPattern}
          resource={chosen.title}
          onBack={() => setChosen(undefined)}
          onConnect={async (accountId, resourceUrl) => {
            // Disposed by hand: `using` is not lowered for every browser this runs in.
            const overseer = api.openWorkspace(workspaceId)
            // Typed as nullable, but never null: it throws instead. Pipelined, so what it is comes with it.
            const gatekeeper = overseer.newGatekeeper(accountId, resourceUrl) as RpcPromise<GatekeeperClient<never>>
            try {
              const [gatekeeperId, description] = await Promise.all([gatekeeper.getId(), gatekeeper.describe()])
              // What was chosen, which in a group may be any of its kinds.
              const kind = resourceOfUrl(chosen.kinds, resourceUrl)?.title ?? chosen.title
              await onAdded({ gatekeeperId, description, vendorId: chosen.vendorId, service: chosen.service, kind })
            } finally {
              gatekeeper[Symbol.dispose]()
              overseer[Symbol.dispose]()
            }
          }}
        />
      )}
    </>
  )
})
