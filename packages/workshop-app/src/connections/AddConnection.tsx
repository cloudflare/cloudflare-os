import { memo, useMemo, useState, type ReactNode } from 'react'
import type { RpcPromise } from 'capnweb'
import type { GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ResourceDescription } from '@gadgets/workshop-shared/gatekeeper'
import { AddConnectionDialog } from '@/blocks/AddConnectionDialog'
import { ChatModelDialog } from '@/blocks/ChatModelDialog'
import { useBindableModels } from '@/gadgets/useBindableModels'
import { Dialog } from '@gadgets/ui'
import { useApi } from '@/rpc/ApiContext'
import { AGENT_CHOICE, AGENT_KEY, AGENT_SERVICE, MODEL_CHOICE, MODEL_KEY, MODEL_SERVICE, serviceChoices, type AddableConnection, type AddableService } from './connectionChoices'
import { resourceOfUrl } from './connectionList'
import { ConnectResource, MakeAgent } from './SetUpConnection'
import { useConnections } from './useConnections'

/**
 * How a connection was made: to a resource through one of the user's accounts (`newGatekeeper`),
 * to one of their models (`newAiModelGatekeeper`), or as an agent of that name with that model
 * (`newAgentSpawnerGatekeeper`), so that it can be made again in another workspace.
 */
export type ConnectionSource = { accountId: number; resourceUrl: string } | { modelId: string } | { agent: { name: string; modelId: string } }

/** A connection just made in a workspace (`newGatekeeper`), as much of it as is shown. */
export type AddedConnection = {
  gatekeeperId: number
  /** The workspace it was made in, whose connection `gatekeeperId` is. */
  workspaceId: string
  source: ConnectionSource
  description: ResourceDescription
  vendorId: string
  service: { name: string; logoUrl?: string; color?: string; glyph?: ReactNode }
  /** What kind of resource it is, as its service names it: "Repository". */
  kind: string
}

export type AddConnectionProps = {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is added to, as the dialogs say it: "this chat". */
  to: string
  /**
   * The service chosen before it was opened, as from the + menu: it opens at which of that
   * service's kinds, or at setting up the one it has, where Back goes to everything there is.
   */
  start?: AddableService
  /** Hands the connection to what it was added for; the dialogs close once it resolves. */
  onAdded: (connection: AddedConnection) => Promise<void>
}

// What it opens at setting up: the one kind of a service chosen for it that has no other.
const onlyKind = (service: AddableService | undefined) => (service?.kinds.length === 1 ? service.kinds[0] : undefined)

/**
 * Adds a connection to a chat, as the user chose rather than an agent asked: what to connect
 * (`AddConnectionDialog`), from one of their models, an agent, and every kind of resource of the
 * services that can be connected, those the user has an account on first; then which one, in that service's own form
 * (`ConnectResource`), making it in the workspace (`newGatekeeper`) and handing it over. Drawn
 * again only for props of its own, not with the chat it is in as each word of a reply comes: a
 * stable `onAdded` keeps it so.
 */
export const AddConnection = memo(function AddConnection({ workspaceId, open, onOpenChange, to, start, onAdded }: AddConnectionProps) {
  const { api } = useApi()
  const { state } = useConnections()
  // What is being set up, whose form is the page shown, until Back. It stays after closing, so
  // that the page shown is the one that closes; each opening starts at choosing, or at the one
  // kind of the service chosen for it.
  const [chosen, setChosen] = useState<AddableConnection | undefined>(open ? onlyKind(start) : undefined)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setChosen(onlyKind(start))
  }
  // The service chosen for it, where it has several kinds to choose among: only those are listed.
  const within = start && start.kinds.length > 1 ? start : undefined
  const models = useBindableModels()

  const choices = useMemo(() => (state.status === 'ready' ? serviceChoices(state.connections) : undefined), [state])
  const everything = useMemo(() => choices && [MODEL_CHOICE, AGENT_CHOICE, ...choices], [choices])
  const offered = within ? within.kinds : everything

  return (
    // One dialog that goes from the choice to its service's form and back as pages, rather than
    // one put away for another. Each kind is a page of its own, so its form starts afresh.
    <Dialog open={open} onOpenChange={onOpenChange} wide={chosen !== undefined && 'vendorId' in chosen} page={chosen ? { key: chosen.key, depth: 1 } : { key: within?.key ?? '', depth: 0 }}>
      {!chosen ? (
        <AddConnectionDialog
          open={open}
          onOpenChange={onOpenChange}
          to={to}
          service={within?.service.name}
          choices={offered}
          problem={!within && state.status === 'failed' ? `Couldn’t read your services: ${state.message}` : undefined}
          onChoose={(choice) => setChosen(offered?.find(({ key }) => key === choice.key))}
        />
      ) : chosen.key === AGENT_KEY ? (
        <MakeAgent
          workspaceId={workspaceId}
          open={open}
          onOpenChange={onOpenChange}
          onBack={() => setChosen(undefined)}
          onMade={async ({ agent, setup }) => {
            const [gatekeeperId, description] = await Promise.all([agent.getId(), agent.describe()])
            await onAdded({ gatekeeperId, workspaceId, source: { agent: setup }, description: { ...description, title: setup.name }, vendorId: AGENT_KEY, service: AGENT_SERVICE, kind: 'Agent' })
          }}
        />
      ) : !('vendorId' in chosen) ? (
        <ChatModelDialog
          open={open}
          onOpenChange={onOpenChange}
          models={models?.models}
          initialModel={models?.initial}
          onBack={() => setChosen(undefined)}
          onAdd={async (modelId) => {
            // Disposed by hand: `using` is not lowered for every browser this runs in.
            const overseer = api.openWorkspace(workspaceId)
            const gatekeeper = overseer.newAiModelGatekeeper(modelId)
            try {
              const [gatekeeperId, description] = await Promise.all([gatekeeper.getId(), gatekeeper.describe()])
              const name = models?.models.find(({ id }) => id === modelId)?.name ?? description.title
              await onAdded({ gatekeeperId, workspaceId, source: { modelId }, description: { ...description, title: name }, vendorId: MODEL_KEY, service: MODEL_SERVICE, kind: 'AI model' })
            } finally {
              gatekeeper[Symbol.dispose]()
              overseer[Symbol.dispose]()
            }
          }}
        />
      ) : (
        <ConnectResource
          open={open}
          onOpenChange={onOpenChange}
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
              await onAdded({ gatekeeperId, workspaceId, source: { accountId, resourceUrl }, description, vendorId: chosen.vendorId, service: chosen.service, kind })
            } finally {
              gatekeeper[Symbol.dispose]()
              overseer[Symbol.dispose]()
            }
          }}
        />
      )}
    </Dialog>
  )
})
