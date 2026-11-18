import { useEffect, useState, type ReactNode } from 'react'
import type { RpcPromise } from 'capnweb'
import { AGENT_SPAWNER_CONNECTION_ID, type GatekeeperClient } from '@gadgets/workshop-shared/api'
import { getResourceTypeId, type ResourceConfiguratorFrame as Frame } from '@gadgets/workshop-shared/gatekeeper'
import { SetUpAgentDialog, type AgentModel } from '@/blocks/SetUpAgentDialog'
import { SetUpConnectionDialog } from '@/blocks/SetUpConnectionDialog'
import { useDefaultModel } from '@/chat/useDefaultModel'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { openConnectWindow } from './connectHandoff'
import { accountLabel, groupedKinds, isGranted, newAccountOf } from './connectionList'
import { ResourceConfiguratorFrame } from './ResourceConfiguratorFrame'
import { useConnections } from './useConnections'

/** An agent's connection request (a `connectionRequest` message), as much of it as setting it up needs. */
export type ConnectionRequest = {
  requestId: string
  vendorId: string
  vendorName: string
  logoUrl?: string
  /** What is asked for, as the card says it. */
  scope?: string
  reason: string
  /** The kind of resource asked for (`SupportedResource.urlPattern`); absent for an agent. */
  resourceUrlPattern?: string
  /** Which one, as far as the agent could tell, to fill the service's form in with. */
  resourceUrl?: string
}

export type SetUpConnectionProps = {
  workspaceId: string
  request: ConnectionRequest
  open: boolean
  onOpenChange: (open: boolean) => void
}

// `ui` is typed as a stub of a bare RpcTarget, which leaves out the disposer every stub has.
const release = (frame: Frame) => (frame.ui as Partial<Disposable>)[Symbol.dispose]?.()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Sets up what an agent asked to be connected to, as the Workshop's gatekeeper dialog does when
 * opened from a request: one of the user's accounts on the service, connected first where there is
 * none, with access to the kind of resource asked for; the service's own form for which one,
 * filled in with what the agent knew; then a gatekeeper for it in the workspace (`newGatekeeper`),
 * handed to the agent (`acceptConnectionRequest`). An agent the chat can call on (an agent
 * spawner) is named and given a model instead.
 */
export const SetUpConnection = (props: SetUpConnectionProps) =>
  props.request.vendorId === AGENT_SPAWNER_CONNECTION_ID ? <SetUpAgent {...props} /> : <SetUpService {...props} />

/** The models an agent can think with, read while `open`; undefined until they are. */
const useAgentModels = (open: boolean) => {
  const { api, reconnecting } = useApi()
  const [models, setModels] = useState<AgentModel[]>()
  useEffect(() => {
    if (!open || reconnecting) return
    let cancelled = false
    api.listModels().then(
      (list) => { if (!cancelled) setModels(list.map(({ id, name }) => ({ id, name }))) },
      () => { if (!cancelled) setModels([]) },
    )
    return () => { cancelled = true }
  }, [api, reconnecting, open])
  return models
}

const SetUpAgent = ({ workspaceId, request, open, onOpenChange }: SetUpConnectionProps) => {
  const { api } = useApi()
  const models = useAgentModels(open)
  const preferred = useDefaultModel()
  return (
    <SetUpAgentDialog
      open={open}
      onOpenChange={onOpenChange}
      reason={request.reason}
      models={models}
      initialModel={preferred.status === 'ready' ? preferred.id : undefined}
      onSetUp={async ({ name, modelId }) => {
        // Disposed by hand: `using` is not lowered for every browser this runs in.
        const overseer = api.openWorkspace(workspaceId)
        const agent = overseer.newAgentSpawnerGatekeeper({ displayName: name, modelId, env: {} })
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
      vendorId={request.vendorId}
      name={request.vendorName}
      logoUrl={request.logoUrl}
      resourceUrlPattern={request.resourceUrlPattern}
      resourceUrl={request.resourceUrl}
      resource={request.scope}
      reason={request.reason}
      onConnect={async (accountId, resourceUrl) => {
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
      save?: never
    }
  | {
      onConnect?: never
      save?: never
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
  | {
      onConnect?: never
      create?: never
      /**
       * Saves a file, rather than connecting anything, as a kind of resource that is made from
       * one (`SupportedResource.savableFrom`): in the account chosen, where the kind's creation
       * form, opened for saving, chose (`destination`). Nothing else is asked of the account, as
       * the form asks for what it needs itself.
       */
      save: {
        /** What the dialog does: "Save to Google Doc". */
        title: string
        /** What else is asked, such as the file's name, before the form. */
        fields?: ReactNode
        /** What else is asked has been answered. */
        ready: boolean
        onSave: (accountId: number, destination: string) => Promise<void>
      }
    }

export type ConnectResourceProps = Making & {
  open: boolean
  onOpenChange: (open: boolean) => void
  vendorId: string
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The kind of resource (`SupportedResource.urlPattern`); absent when it is not known. */
  resourceUrlPattern?: string
  /** Which one, when it is known, to fill the service's form in with; or what to suggest in a creation form. */
  resourceUrl?: string
  /** What is connected, in words: "GitHub repository". */
  resource?: string
  /** Why the agent asked for it. */
  reason?: string
  /** Goes back to choosing what to connect, where that was chosen before this. */
  onBack?: () => void
}

/**
 * Connects one of a service's resources (`SetUpConnectionDialog`): one of the user's accounts on it,
 * connected first where there is none, with access to the kind of resource; then the service's own
 * form for which one; then `onConnect`, which makes it what the caller needs. Given `create`, it
 * creates one instead: the account, then where and how, in the service's creation form where the
 * kind has one (`SupportedResource.creationConfigurator`). Given `save`, it saves a file as one: the
 * account, then where, in that form opened for saving.
 */
export const ConnectResource = ({
  open, onOpenChange, vendorId, name, logoUrl, resourceUrlPattern: pattern, resourceUrl, resource, reason, onBack, onConnect, create, save,
}: ConnectResourceProps) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const { state } = useConnections()
  const listed = state.status === 'ready' ? state.connections.filter((each) => each.vendorId === vendorId) : undefined
  const accounts = listed?.flatMap((each) => (each.kind === 'account' ? [each.account] : []))
  const vendor = listed?.[0]?.vendor
  const resources = listed?.[0]?.resources ?? []
  const kind = resources.find(({ urlPattern }) => urlPattern === pattern)
  // The kinds its form may choose: those shown with it, or, created or saved, just it.
  const kinds = pattern === undefined ? [] : create || save ? [pattern] : groupedKinds(resources, pattern)
  // A save only hands the account a file, so it is given no access to anything for it.
  const grantable = save ? [] : resources.filter((candidate) => candidate.grantable && kinds.includes(candidate.urlPattern)).map(({ urlPattern }) => urlPattern)

  // The account chosen; until one is, the first that can be used.
  const [chosen, setChosen] = useState<number>()
  // The accounts there were when another was asked for, so the one that comes is chosen.
  const [before, setBefore] = useState<ReadonlySet<number>>()
  const made = before && accounts && newAccountOf(accounts, vendorId, before)
  if (made) {
    setBefore(undefined)
    setChosen(made.id)
  }
  const selected = accounts?.find(({ id }) => id === chosen) ?? accounts?.find(({ credentialsValid }) => credentialsValid) ?? accounts?.[0]
  const usable = selected?.credentialsValid ? selected : undefined
  const ungranted = usable ? grantable.filter((each) => !isGranted(usable.description.grantedResourceUrlPatterns, each)) : []
  // The form opens once the kind asked for may be reached, offering what else in it may be too;
  // giving access asks for all of them at once.
  const needsGrant = usable !== undefined && pattern !== undefined && ungranted.includes(pattern)
  const accepted = kinds.filter((each) => !ungranted.includes(each))
  const grant = async () => {
    if (connection?.blocked() || !usable) return false
    const flow = await api.ensureAccountResources(usable.id, ungranted)
    if (flow) openConnectWindow(flow)
    return true
  }
  const grantedKey = usable?.description.grantedResourceUrlPatterns?.join('\n')

  // The service's form, for the account chosen once it may reach this kind of resource.
  const [frame, setFrame] = useState<{ accountId: number; frame: Frame } | { accountId: number; problem: string }>()
  const [collect, setCollect] = useState<{ collect: () => Promise<string> }>()
  const [ready, setReady] = useState(false)
  // A creation of a kind without a form needs nothing more than the account.
  const formless = create !== undefined && kind !== undefined && !kind.creationConfigurator
  // Only once the kind is known, as whether it has a creation form is.
  const accountId = open && usable && !needsGrant && pattern && !formless && (!(create || save) || kind) ? usable.id : undefined
  const purpose = save ? 'save' : create ? 'create' : 'connect'
  // A save names the kind by its id, as `saveFile()` does.
  const typeId = save && kind ? getResourceTypeId(kind) : pattern
  useEffect(() => {
    if (accountId === undefined || typeId === undefined || reconnecting) return
    let current = true
    let started: Frame | undefined
    const start = purpose === 'connect'
      ? api.startResourceConfigurator(accountId, typeId)
      : api.startCreationConfigurator(accountId, typeId, purpose === 'save' ? 'save' : undefined)
    start.then(
      (next) => {
        started = next
        if (current) setFrame({ accountId, frame: next })
        else release(next)
      },
      (error: unknown) => {
        if (current) setFrame({ accountId, problem: `Couldn’t open ${name}’s form: ${messageOf(error)}` })
      },
    )
    return () => {
      current = false
      if (started) release(started)
      setFrame(undefined)
      setReady(false)
    }
    // A new grant starts it again, as a form reads the kinds it may offer only when it starts.
  }, [api, reconnecting, accountId, typeId, grantedKey, name, purpose])

  const shown = frame && frame.accountId === accountId ? frame : undefined
  return (
    <SetUpConnectionDialog
      open={open}
      onOpenChange={onOpenChange}
      name={name}
      logoUrl={logoUrl ?? vendor?.logo?.url}
      color={vendor?.color}
      title={create?.title ?? save?.title}
      accept={save ? { label: 'Save', pending: 'Saving…' } : create && { label: 'Create', pending: 'Creating…' }}
      noAccount={save ? `Connect your ${name} account first. It’s saved there.` : create && `Connect your ${name} account first. It’s created there.`}
      resource={resource}
      reason={reason}
      onBack={onBack}
      accounts={accounts?.map((account) => ({
        id: account.id,
        name: accountLabel(account.description) ?? account.vendor.displayName,
        expired: !account.credentialsValid,
      }))}
      selectedAccountId={selected?.id}
      onSelectAccount={setChosen}
      onConnectAccount={async () => {
        if (connection?.blocked()) return false
        setBefore(new Set(accounts?.map(({ id }) => id)))
        // Only what its form may choose, where the service grants each kind on its own; for a save,
        // nothing, where none named would ask for everything.
        openConnectWindow(await api.connectAccount(vendorId, save || grantable.length > 0 ? grantable : undefined))
        return true
      }}
      onReconnect={async (id) => {
        if (connection?.blocked()) return false
        openConnectWindow(await api.reconnectAccount(id))
        return true
      }}
      onGrant={needsGrant ? grant : undefined}
      // The rest of what the form could offer, as the old app asks for it beside the form.
      onGrantMore={!needsGrant && usable && ungranted.length > 0 ? grant : undefined}
      fields={save?.fields}
      configurator={formless ? undefined : pattern === undefined ? (
        <p className="text-base/5 text-kumo-subtle">The agent didn’t say what kind of resource it wants. Ask it again.</p>
      ) : shown && 'problem' in shown ? (
        <p role="alert" className="text-base/5 text-kumo-danger">{shown.problem}</p>
      ) : (
        // Mounted while the form is fetched too, so that what says it is opening stays until it is drawn.
        <ResourceConfiguratorFrame
          key={accountId}
          frame={shown?.frame}
          opening={<p role="status" className="appears-late text-base text-kumo-subtle">Opening {name}’s form…</p>}
          initialResource={resourceUrl ? { resourceUrl, resourceUrlPattern: pattern } : undefined}
          acceptedResourceUrlPatterns={accepted}
          ensureResources={async (urlPatterns) => {
            if (connection?.blocked() || !shown) return false
            const flow = await api.ensureAccountResources(shown.accountId, urlPatterns)
            if (flow) openConnectWindow(flow)
            return true
          }}
          onReady={setReady}
          onCollect={(next) => setCollect(next && { collect: next })}
        />
      )}
      ready={(save?.ready ?? true) && (formless || (ready && collect !== undefined))}
      onAccept={async () => {
        if (connection?.blocked() || !usable) return false
        if (save) {
          if (!collect) return false
          await save.onSave(usable.id, await collect.collect())
        } else if (create) await create.onCreate(usable.id, collect && !formless ? await collect.collect() : undefined)
        else if (collect) await onConnect(usable.id, await collect.collect())
        else return false
        onOpenChange(false)
        return true
      }}
    />
  )
}
