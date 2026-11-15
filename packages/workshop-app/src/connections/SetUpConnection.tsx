import { useEffect, useState } from 'react'
import type { RpcPromise } from 'capnweb'
import { AGENT_SPAWNER_CONNECTION_ID, type GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ResourceConfiguratorFrame as Frame } from '@gadgets/workshop-shared/gatekeeper'
import { isGranted } from '@/blocks/resourceGrants'
import { SetUpAgentDialog } from '@/blocks/SetUpAgentDialog'
import { SetUpConnectionDialog } from '@/blocks/SetUpConnectionDialog'
import { useModels } from '@/chat/useModels'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useConnectedAccounts } from './ConnectedAccountsContext'
import { openConnectWindow } from './connectHandoff'
import { accountName, newAccountOf } from './connectionGroups'
import { ResourceConfiguratorFrame } from './ResourceConfiguratorFrame'
import { useServices } from './useServices'

/** An agent's connection request (a `connectionRequest` message), as much of it as setting it up needs. */
export type ConnectionRequest = {
  requestId: string
  vendorId: string
  vendorName: string
  logoUrl?: string
  /** What is asked for, as the card says it. */
  scope?: string
  reason: string
  resourceUrlPattern?: string
  resourceUrl?: string
}

export type SetUpConnectionProps = {
  workspaceId: string
  /** The chat that asked, which an agent set up here reports back to. */
  chatId?: number
  request: ConnectionRequest
  open: boolean
  onOpenChange: (open: boolean) => void
}

// `ui` is typed as a stub of a bare RpcTarget, which leaves out the disposer every stub has.
const release = (frame: Frame) => (frame.ui as Partial<Disposable>)[Symbol.dispose]?.()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Sets up what an agent asked to be connected to (`SetUpConnectionDialog`), as the old Workshop's
 * gatekeeper dialog does when opened from a request: one of the user's accounts on the service,
 * connected first if there is none, with access to the kind of resource asked for; the service's
 * own form for which one, filled in with what the agent knew; then a gatekeeper for it in the
 * workspace (`newGatekeeper`), handed to the agent (`acceptConnectionRequest`).
 */
export const SetUpConnection = (props: SetUpConnectionProps) =>
  props.request.vendorId === AGENT_SPAWNER_CONNECTION_ID ? <SetUpAgent {...props} /> : <SetUpService {...props} />

// An agent the chat can call on (an agent spawner) is named and given a model, then handed to the
// chat, reporting each run back to it unless told not to.
const SetUpAgent = ({ workspaceId, chatId, request, open, onOpenChange }: SetUpConnectionProps) => {
  const { api } = useApi()
  const { models } = useModels()
  return (
    <SetUpAgentDialog
      open={open}
      onOpenChange={onOpenChange}
      reason={request.reason}
      models={models.status === 'ready' ? models.offered.map(({ id, name }) => ({ id, name })) : models.status === 'failed' ? [] : undefined}
      initialModel={models.status === 'ready' ? models.preferred : undefined}
      onSetUp={async ({ name, modelId, reportHere }) => {
        const overseer = api.openWorkspace(workspaceId)
        const agent = overseer.newAgentSpawnerGatekeeper({
          displayName: name,
          modelId,
          env: {},
          ...(reportHere && chatId !== undefined ? { reportsToChatId: chatId } : {}),
        })
        try {
          await overseer.acceptConnectionRequest(request.requestId, { gatekeeperId: await agent.getId() })
        } finally {
          agent[Symbol.dispose]()
          overseer[Symbol.dispose]()
        }
      }}
    />
  )
}

const SetUpService = ({ workspaceId, request, open, onOpenChange }: SetUpConnectionProps) => {
  const { api } = useApi()
  return (
    <ConnectResource
      open={open}
      onOpenChange={onOpenChange}
      service={{ vendorId: request.vendorId, name: request.vendorName, logoUrl: request.logoUrl }}
      resourceUrlPattern={request.resourceUrlPattern}
      resourceUrl={request.resourceUrl}
      scope={request.scope}
      description={request.scope ? `The agent asked for ${request.scope}.` : undefined}
      reason={request.reason}
      unknownKind="The agent didn’t say what kind of resource it wants. Ask it again."
      onConnect={async (accountId, resourceUrl) => {
        // Disposed by hand: `using` is not lowered for every browser this runs in.
        const overseer = api.openWorkspace(workspaceId)
        // Typed as nullable, but never null: it throws instead. Pipelined, so its id comes with it.
        const gatekeeper = overseer.newGatekeeper(accountId, resourceUrl) as RpcPromise<GatekeeperClient<never>>
        try {
          await overseer.acceptConnectionRequest(request.requestId, { gatekeeperId: await gatekeeper.getId() })
        } finally {
          gatekeeper[Symbol.dispose]()
          overseer[Symbol.dispose]()
        }
      }}
    />
  )
}

/** What `ConnectResource` makes of what was chosen. */
type Making =
  | {
      /** Makes what was chosen, with the account it was chosen in. The dialog closes once it resolves. */
      onConnect: (accountId: number, resourceUrl: string) => Promise<void>
      create?: never
    }
  | {
      onConnect?: never
      /**
       * Creates, rather than connects, what an agent asked for (`ActionLogEntry.creation`): in the
       * account chosen and, for a kind with one, as its creation form chose (`configuration`).
       */
      create: {
        /** What is created, as the dialog's title says it: "Create Document: Weekly notes". */
        title: string
        onCreate: (accountId: number, configuration: string | undefined) => Promise<void>
      }
    }

export type ConnectResourceProps = Making & {
  open: boolean
  onOpenChange: (open: boolean) => void
  service: { vendorId: string; name: string; logoUrl?: string }
  /** The kind of resource (`SupportedResource.urlPattern`); absent when it is not known. */
  resourceUrlPattern?: string
  /** Which one, when it is known, to fill the service's form in with; what to suggest in a creation form. */
  resourceUrl?: string
  /** What is connected, in words: "a GitHub repository". */
  scope?: string
  description?: string
  reason?: string
  /** What is said in place of the form when the kind is not known. */
  unknownKind?: string
  onBack?: () => void
}

/**
 * Connects one of a service's resources (`SetUpConnectionDialog`): one of the user's accounts on
 * it, connected first if there is none, with access to the kind of resource; then the service's own
 * form for which one; then `onConnect`, which makes it what the caller needs. Given `create`, it
 * creates one instead: the account, then where and how, in the service's creation form where the
 * kind has one (`SupportedResource.creationConfigurator`).
 */
export const ConnectResource = ({
  open, onOpenChange, service, resourceUrlPattern: pattern, resourceUrl, scope, description, reason, unknownKind, onBack, onConnect, create,
}: ConnectResourceProps) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const snapshot = useConnectedAccounts()
  const { services } = useServices()
  const accounts = snapshot.status === 'ready' ? snapshot.accounts.filter(({ vendorId }) => vendorId === service.vendorId) : undefined
  const vendor = services.status === 'ready' ? services.vendors.find(({ id }) => id === service.vendorId) : undefined
  const resources = vendor?.supportedResources ?? accounts?.[0]?.supportedResources ?? []
  const resource = resources.find(({ urlPattern }) => urlPattern === pattern)

  // The account chosen; until one is, the first that can be used.
  const [chosen, setChosen] = useState<number>()
  // The accounts there were when another was asked for, so the one that comes is chosen.
  const [before, setBefore] = useState<ReadonlySet<number>>()
  const made = before && accounts && newAccountOf(accounts, service.vendorId, before)
  if (made) {
    setBefore(undefined)
    setChosen(made.id)
  }
  const selected = accounts?.find(({ id }) => id === chosen) ?? accounts?.find(({ credentialsValid }) => credentialsValid) ?? accounts?.[0]
  const usable = selected?.credentialsValid ? selected : undefined
  const needsGrant = usable !== undefined && pattern !== undefined && resource?.grantable === true &&
    !isGranted(usable.description.grantedResourceUrlPatterns, pattern)
  const grantedKey = usable?.description.grantedResourceUrlPatterns?.join('\n')

  // The service's form, for the account chosen once it may reach this kind of resource.
  const [frame, setFrame] = useState<{ accountId: number; frame: Frame } | { accountId: number; problem: string }>()
  const [collect, setCollect] = useState<{ collect: () => Promise<string> }>()
  const [ready, setReady] = useState(false)
  // A creation of a kind without a form needs nothing more than the account.
  const formless = create !== undefined && resource !== undefined && !resource.creationConfigurator
  // Only once the kind is known, as whether it has a creation form is.
  const accountId = open && usable && !needsGrant && pattern && !formless && (!create || resource) ? usable.id : undefined
  useEffect(() => {
    if (accountId === undefined || pattern === undefined || reconnecting) return
    let current = true
    let started: Frame | undefined
    const start = create ? api.startCreationConfigurator(accountId, pattern) : api.startResourceConfigurator(accountId, pattern)
    start.then(
      (next) => {
        started = next
        if (current) setFrame({ accountId, frame: next })
        else release(next)
      },
      (error: unknown) => {
        if (current) setFrame({ accountId, problem: `Couldn’t open ${service.name}’s form: ${messageOf(error)}` })
      },
    )
    return () => {
      current = false
      if (started) release(started)
      setFrame(undefined)
      setReady(false)
    }
    // A new grant restarts it, as a form reads the kinds it may offer only when it starts.
  }, [api, reconnecting, accountId, pattern, grantedKey, service.name, create !== undefined])

  const grantable = resources.filter((candidate) => candidate.grantable).map(({ urlPattern }) => urlPattern)
  const connect = async () => {
    if (connection?.blocked()) return false
    setBefore(new Set(accounts?.map(({ id }) => id)))
    // Only what was asked for, where the service grants each kind on its own.
    openConnectWindow(await api.connectAccount(service.vendorId, pattern && grantable.includes(pattern) ? [pattern] : undefined))
    return true
  }

  const shown = frame && frame.accountId === accountId ? frame : undefined
  return (
    <SetUpConnectionDialog
      open={open}
      onOpenChange={onOpenChange}
      service={{ name: service.name, logoUrl: service.logoUrl ?? vendor?.description.logo?.url, color: vendor?.description.color }}
      title={create?.title}
      accept={create && { label: 'Create', pending: 'Creating…' }}
      noAccount={create && `Connect your ${service.name} account first. It’s created there.`}
      resource={scope}
      description={description}
      reason={reason}
      onBack={onBack}
      accounts={accounts?.map((account) => ({
        id: account.id,
        name: accountName(account) ?? account.description.displayName ?? account.vendor.displayName,
        expired: !account.credentialsValid,
      }))}
      selectedAccountId={selected?.id}
      onSelectAccount={setChosen}
      onConnectAccount={connect}
      onReconnect={async (id) => {
        if (connection?.blocked()) return false
        openConnectWindow(await api.reconnectAccount(id))
        return true
      }}
      onGrant={needsGrant ? async () => {
        if (connection?.blocked()) return false
        const flow = await api.ensureAccountResources(usable.id, [pattern])
        if (flow) openConnectWindow(flow)
        return true
      } : undefined}
      configurator={formless ? undefined : pattern === undefined ? (
        <p className="text-base/5 text-kumo-subtle">{unknownKind}</p>
      ) : shown && 'problem' in shown ? (
        <p role="alert" className="text-base/5 text-kumo-danger">{shown.problem}</p>
      ) : shown ? (
        <ResourceConfiguratorFrame
          key={shown.accountId}
          frame={shown.frame}
          initialResource={resourceUrl ? { resourceUrl, resourceUrlPattern: pattern } : undefined}
          acceptedResourceUrlPatterns={[pattern]}
          ensureResources={async (urlPatterns) => {
            if (connection?.blocked()) return false
            const flow = await api.ensureAccountResources(shown.accountId, urlPatterns)
            if (flow) openConnectWindow(flow)
            return true
          }}
          onReady={setReady}
          onCollect={(next) => setCollect(next && { collect: next })}
        />
      ) : (
        <p role="status" className="appears-late text-base text-kumo-subtle">Opening {service.name}’s form…</p>
      )}
      ready={formless || (ready && collect !== undefined)}
      onAccept={async () => {
        if (connection?.blocked() || !usable) return false
        if (create) await create.onCreate(usable.id, collect && !formless ? await collect.collect() : undefined)
        else if (collect) await onConnect(usable.id, await collect.collect())
        else return false
        onOpenChange(false)
        return true
      }}
    />
  )
}
