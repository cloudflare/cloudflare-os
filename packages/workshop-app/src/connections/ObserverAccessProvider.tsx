import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RpcTarget, type RpcStub } from 'capnweb'
import { useRouterState } from '@tanstack/react-router'
import type { AuthenticatedApi, GatekeeperVendorInfo, ObserverAccountChoice, ObserverBindingNeed, ObserverConfigCallback } from '@gadgets/workshop-shared/api'
import { parseItemPageId } from '@/aside/asideItems'
import { ConfirmAccessDialog, type ConfirmAccessRow } from '@/blocks/ConfirmAccessDialog'
import { ApiContext, useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { protectedResources } from '@/workspaces/sharingRules'
import { openConnectWindow } from './connectHandoff'
import { ConnectedAccounts } from './ConnectedAccounts'
import { accountLabel, type ConnectedAccount } from './connectionList'
import { accountChoices, accountsFor, accountWillDo, defaultChoices, missingAccess, refusedAccount, requiredAccess, type AccessChoices } from './observerAccess'

/** What answers the overseer when it asks which accounts the user confirms their access with. */
class ObserverConfig extends RpcTarget implements ObserverConfigCallback {
  constructor(private readonly ask: (needs: ObserverBindingNeed[]) => Promise<ObserverAccountChoice[]>) {
    super()
  }

  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    return this.ask(needs)
  }
}

type Configure = (what: string, workspaceId: string) => RpcStub<ObserverConfigCallback>

// The overseer an open gave, with its gadgets got as the user's own access asks: a collaborator on
// one gadget alone is verified when they get it, not when the workspace opens. Over the stub, so
// that it is still pipelined and disposed of as one.
const withGadgetAccess = <Overseer extends object>(overseer: Overseer, workspaceId: string, configure: Configure): Overseer =>
  new Proxy(overseer, {
    get(target, prop) {
      const value = (target as Record<PropertyKey, unknown>)[prop]
      if (prop !== 'getGadget') return value
      const getGadget = value as (id: number, given?: RpcStub<ObserverConfigCallback>) => unknown
      return (id: number, given?: RpcStub<ObserverConfigCallback>) => getGadget(id, given ?? configure('this gadget', workspaceId))
    },
  })

/**
 * The API, with every workspace it opens, and every gadget got from one, ready to ask the user to
 * confirm their access where the overseer needs that of them (`ObserverConfigCallback`): so that
 * nothing that opens one has to know to.
 */
export const withObserverAccess = (api: RpcStub<AuthenticatedApi>, configure: Configure): RpcStub<AuthenticatedApi> =>
  new Proxy(api, {
    get(target, prop) {
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop]
      if (prop !== 'openWorkspace') return value
      const open = value as AuthenticatedApi['openWorkspace']
      return (id: string, shareKey?: string, given?: RpcStub<ObserverConfigCallback>) =>
        withGadgetAccess(open(id, shareKey, given ?? configure('this workspace', id)), id, configure)
    },
  })

// One question of the user, and everyone waiting on its answer: several opens of one workspace at
// once (the sidebar's and the page's) ask the same thing, which is asked once.
type Asking = {
  key: string
  what: string
  needs: ObserverBindingNeed[]
  waiting: { resolve: (choices: ObserverAccountChoice[]) => void; reject: (error: Error) => void }[]
}

const askingKey = (needs: readonly ObserverBindingNeed[]) =>
  needs.map(({ gatekeeperId, failure }) => `${gatekeeperId}${failure ? '!' : ''}`).toSorted().join(',')

/** The workspace a page shows, by its address: its own pages, or one of its items on a page of its own. */
export const viewedWorkspace = (pathname: string): string | undefined => {
  const workspace = /^\/workspace\/([^/]+)/.exec(pathname)
  if (workspace) return decodeURIComponent(workspace[1])
  const item = /^\/(?:app|library)\/([^/]+)/.exec(pathname)
  return item ? parseItemPageId(decodeURIComponent(item[1]))?.workspaceId : undefined
}

const NOT_CONFIRMED = 'You didn’t confirm your access, so it can’t be opened.'

/** Whether an open failed only for the user's access not being confirmed, which asking again can put right. */
export const accessNotConfirmed = (message: string) => message.includes(NOT_CONFIRMED)

// Forgets what the user cancelled, so that the next open asks them again.
const AskAgainContext = createContext<() => void>(() => {})

/** Call before opening again what the user cancelled confirming their access to, so that it is asked again. */
export const useAskAccessAgain = () => use(AskAgainContext)

/**
 * Beneath `RpcGate`: the API for everything below, ready to ask the user to confirm their access
 * (`withObserverAccess`), and the dialog that asks (`ConfirmAccess`), one question at a time. What
 * the user cancels is not asked again, as it is opened again and again in the background, until
 * they ask for it (`useAskAccessAgain`).
 */
export const ObserverAccessProvider = ({ children }: { children: ReactNode }) => {
  const session = useApi()
  const queue = useRef<Asking[]>([])
  const declined = useRef(new Set<string>())
  const [asking, setAsking] = useState<Asking>()

  // Only what is on screen asks: the sidebar's counts and what the gadgets ask open the user's
  // recent workspaces in the background, which would otherwise ask of them unbidden, wherever they
  // are. Those are refused, as an open with nothing to ask is.
  const viewing = useRef<string | undefined>(undefined)
  viewing.current = useRouterState({ select: ({ location }) => viewedWorkspace(location.pathname) })
  const ask = useCallback((what: string, workspaceId: string, needs: ObserverBindingNeed[]) => new Promise<ObserverAccountChoice[]>((resolve, reject) => {
    if (workspaceId !== viewing.current) return reject(new Error(NOT_CONFIRMED))
    const key = askingKey(needs)
    if (declined.current.has(key)) return reject(new Error(NOT_CONFIRMED))
    const same = queue.current.find((each) => each.key === key)
    if (same) return void same.waiting.push({ resolve, reject })
    queue.current.push({ key, what, needs, waiting: [{ resolve, reject }] })
    setAsking(queue.current[0])
  }), [])

  const answer = (choices: ObserverAccountChoice[] | undefined) => {
    const [done] = queue.current.splice(0, 1)
    if (done) {
      if (!choices) declined.current.add(done.key)
      for (const { resolve, reject } of done.waiting) {
        if (choices) resolve(choices)
        else reject(new Error(NOT_CONFIRMED))
      }
    }
    setAsking(queue.current[0])
  }

  const askAgain = useCallback(() => declined.current.clear(), [])

  const { api } = session
  const wrapped = useMemo(() => withObserverAccess(api, (what, workspaceId) => new ObserverConfig((needs) => ask(what, workspaceId, needs)) as unknown as RpcStub<ObserverConfigCallback>), [api, ask])
  const value = useMemo(() => ({ ...session, api: wrapped }), [session, wrapped])

  return (
    <ApiContext value={value}>
      <AskAgainContext value={askAgain}>
        {children}
        {asking && <ConfirmAccess key={asking.key} what={asking.what} needs={asking.needs} onAnswer={answer} />}
      </AskAgainContext>
    </ApiContext>
  )
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type ConfirmAccessProps = {
  what: string
  needs: ObserverBindingNeed[]
  /** The accounts confirmed with, for every connection asked about; or none, cancelled. */
  onAnswer: (choices: ObserverAccountChoice[] | undefined) => void
}

/**
 * The dialog (`ConfirmAccessDialog`) over what it asks about: the user's accounts, kept up to date
 * as one is connected in a window of its own, the services, for their logos and what each grants,
 * and each resource once with the account chosen for it, which answers every connection that reads it.
 */
const ConfirmAccess = ({ what, needs, onAnswer }: ConfirmAccessProps) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>()
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>()
  const [picked, setPicked] = useState<AccessChoices>(new Map())
  // What an account was found to have been given after all, which it did not say it had.
  const [granted, setGranted] = useState<ReadonlyMap<number, string[]>>(new Map())
  // What is being started, by the resource it is for, while the request that starts it is out: a
  // window of its own may end without an account, which comes through the accounts if it does.
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    const subscription = api.subscribeConnectedAccounts(new ConnectedAccounts((next) => {
      if (!cancelled) setAccounts(next)
    }), { includeForcedAutoProvisionedAccounts: true })
    subscription.catch((error: unknown) => {
      if (!cancelled) setProblem(`Couldn’t read your accounts: ${messageOf(error)}`)
    })
    Promise.all([api.listGatekeeperVendors(), api.listAddableGatekeepers().catch(() => [])]).then(([listed, addable]) => {
      if (!cancelled) setVendors([...listed, ...addable.filter(({ id }) => !listed.some((each) => each.id === id))])
    }, () => {
      if (!cancelled) setVendors([])
    })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [api])

  const known = accounts?.map((account) => {
    const extra = granted.get(account.id)
    return extra ? { ...account, description: { ...account.description, grantedResourceTypeIds: [...new Set([...(account.description.grantedResourceTypeIds ?? []), ...extra])] } } : account
  })
  const resources = known && vendors ? protectedResources(needs, vendors, { every: true }) ?? [] : undefined
  const chosen = resources && known ? defaultChoices(resources, known, picked) : picked
  const vendorOf = (vendorId: string) => vendors?.find(({ id }) => id.toLowerCase() === vendorId.toLowerCase())

  const during = (key: string, run: () => Promise<unknown>) => {
    if (pending || connection?.blocked()) return
    setProblem(undefined)
    setPending(key)
    run().catch((error: unknown) => setProblem(messageOf(error))).finally(() => setPending(undefined))
  }

  const rows: ConfirmAccessRow[] | undefined = resources && known && resources.map((resource) => {
    const vendor = vendorOf(resource.vendorId)
    const theirs = accountsFor(resource, known)
    const account = theirs.find(({ id }) => id === chosen.get(resource.key))
    const refused = refusedAccount(resource, known)
    const failure = resource.needs.find((need) => need.failure)?.failure
    const missing = account ? missingAccess(account, requiredAccess(resource, vendor, account)) : []
    const automatic = vendor?.description.autoProvisionsAccount === true
    return {
      key: resource.key,
      title: resource.title,
      service: resource.service,
      accounts: theirs.map(({ id, description, vendor: service, credentialsValid }) => ({ id, name: accountLabel(description) ?? service.displayName, expired: !credentialsValid })),
      chosen: account?.id,
      ready: accountWillDo(resource, vendor, account),
      refusal: failure && { account: known.find(({ id }) => id === failure.accountId)?.description.displayName ?? 'The account chosen', reason: failure.reason },
      fix: !account ? undefined
        : missing.length > 0
          ? { kind: 'grant', pending: pending === resource.key, onSelect: () => during(resource.key, async () => {
              const flow = await api.ensureAccountResources(account.id, missing)
              if (flow) openConnectWindow(flow)
              else setGranted((current) => new Map(current).set(account.id, [...(current.get(account.id) ?? []), ...missing]))
            }) }
          : !account.credentialsValid || account.id === refused
            ? { kind: 'reconnect', worthATry: account.credentialsValid, pending: pending === resource.key, onSelect: () => during(resource.key, async () => openConnectWindow(await api.reconnectAccount(account.id))) }
            : undefined,
      connect: automatic && theirs.length > 0 ? undefined : {
        pending: pending === `connect ${resource.key}`,
        onSelect: () => during(`connect ${resource.key}`, async () => {
          if (automatic) return api.provisionAmbientAccount(resource.vendorId)
          const required = requiredAccess(resource, vendor)
          openConnectWindow(await api.connectAccount(resource.vendorId, required.length > 0 ? required : undefined))
        }),
      },
    } satisfies ConfirmAccessRow
  })

  // Answered as it goes, so that it goes as any dialog does, and the next question, if any, comes after.
  const finish = (choices: ObserverAccountChoice[] | undefined) => {
    setOpen(false)
    onAnswer(choices)
  }

  return (
    <ConfirmAccessDialog
      open={open}
      what={what}
      again={needs.some(({ failure }) => failure)}
      rows={rows}
      problem={problem}
      onChoose={(key, accountId) => setPicked((current) => new Map(current).set(key, accountId))}
      onConfirm={() => {
        const choices = resources && accountChoices(resources, chosen)
        if (choices) finish(choices)
      }}
      onCancel={() => finish(undefined)}
    />
  )
}
