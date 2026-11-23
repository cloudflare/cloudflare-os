import { memo, useMemo, useState, type ReactNode } from 'react'
import { AiMagicIcon } from '@/components/icons'
import type { RpcPromise } from 'capnweb'
import { AGENT_SPAWNER_CONNECTION_ID, type GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ResourceDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { AddConnectionDialog, type ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { AgentMark } from '@/blocks/AgentMark'
import { ChatModelDialog } from '@/blocks/ChatModelDialog'
import { useBindableModels } from '@/gadgets/useBindableModels'
import { Dialog } from '@gadgets/ui'
import { useApi } from '@/rpc/ApiContext'
import { resourceGroups, resourceOfUrl } from './connectionList'
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
  /** Hands the connection to what it was added for; the dialogs close once it resolves. */
  onAdded: (connection: AddedConnection) => Promise<void>
}

// One of the user's models, offered with the services, which has a page of its own.
const MODEL_KEY = 'ai-model'
// A sparkle, as the Workshop's own cloud carries, rather than a brain.
const MODEL_SERVICE = { name: 'AI model', glyph: <AiMagicIcon aria-hidden="true" /> }
const MODEL_CHOICE: ConnectionChoice = {
  key: MODEL_KEY,
  service: MODEL_SERVICE,
  title: 'AI model',
  description: 'One of your models, for a gadget’s code to use',
  connected: true,
}

// An agent, offered with them too, as main's Workshop offered it: named and given a model on a page of its own.
const AGENT_KEY = AGENT_SPAWNER_CONNECTION_ID
// Drawn as an agent is everywhere else: the Workshop's cloud.
const AGENT_SERVICE = { name: 'Agent', glyph: <AgentMark size="small" /> }
const AGENT_CHOICE: ConnectionChoice = {
  key: AGENT_KEY,
  service: AGENT_SERVICE,
  title: 'Agent',
  description: 'Works on its own when a gadget calls on it',
  connected: true,
}

type Chosen = ConnectionChoice & {
  vendorId: string
  urlPattern: string
  /** The kinds its form may choose among, when it stands for more than one (`groupedWith`). */
  kinds: SupportedResource[]
}

/**
 * Adds a connection to a chat, as the user chose rather than an agent asked: what to connect
 * (`AddConnectionDialog`), from one of their models, an agent, and every kind of resource of the
 * services that can be connected, those the user has an account on first; then which one, in that service's own form
 * (`ConnectResource`), making it in the workspace (`newGatekeeper`) and handing it over. Drawn
 * again only for props of its own, not with the chat it is in as each word of a reply comes: a
 * stable `onAdded` keeps it so.
 */
export const AddConnection = memo(function AddConnection({ workspaceId, open, onOpenChange, to, onAdded }: AddConnectionProps) {
  const { api } = useApi()
  const { state } = useConnections()
  // What is being set up, whose form is the page shown, until Back. It stays after closing, so
  // that the page shown is the one that closes; each opening starts at choosing.
  const [chosen, setChosen] = useState<Chosen | typeof MODEL_CHOICE | typeof AGENT_CHOICE>()
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setChosen(undefined)
  }
  const models = useBindableModels()

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
  const offered = useMemo(() => choices && [MODEL_CHOICE, AGENT_CHOICE, ...choices], [choices])

  return (
    // One dialog that goes from the choice to its service's form and back as pages, rather than
    // one put away for another. Each kind is a page of its own, so its form starts afresh.
    <Dialog open={open} onOpenChange={onOpenChange} wide={chosen !== undefined && 'vendorId' in chosen} page={chosen ? { key: chosen.key, depth: 1 } : { key: '', depth: 0 }}>
      {!chosen ? (
        <AddConnectionDialog
          open={open}
          onOpenChange={onOpenChange}
          to={to}
          choices={offered}
          problem={state.status === 'failed' ? `Couldn’t read your services: ${state.message}` : undefined}
          onChoose={(choice) => setChosen(choice.key === MODEL_KEY ? MODEL_CHOICE : choice.key === AGENT_KEY ? AGENT_CHOICE : choices?.find(({ key }) => key === choice.key))}
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
