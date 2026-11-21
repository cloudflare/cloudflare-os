import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RpcTarget, type RpcStub } from 'capnweb'
import { useRouterState } from '@tanstack/react-router'
import {
  ACCESS_CONFIRMATION_ERROR_CODES,
  createAccessConfirmationError,
  type AuthenticatedApi,
  type GatekeeperVendorInfo,
  type ObserverAccountChoice,
  type ObserverBindingNeed,
  type ObserverConfigCallback,
} from '@gadgets/workshop-shared/api'
import { parseItemPageId } from '@/aside/asideItems'
import { ConfirmAccessForm, type ConfirmAccessIssue, type ConfirmAccessRow } from '@/blocks/ConfirmAccessForm'
import { ApiContext, useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { protectedResources } from '@/workspaces/sharingRules'
import { openConnectWindow } from './connectHandoff'
import { ConnectedAccounts } from './ConnectedAccounts'
import { accountLabel, type ConnectedAccount } from './connectionList'
import { askable, holderOf, PAGE, placeOf } from './accessQuestions'
import { accessNames, accountChoices, accountsFor, accountWillDo, defaultChoices, missingAccess, refusedAccount, requiredAccess, type AccessChoices } from './observerAccess'

/** What answers the overseer when it asks which accounts the user confirms their access with. */
class ObserverConfig extends RpcTarget implements ObserverConfigCallback {
  constructor(private readonly ask: (needs: ObserverBindingNeed[]) => Promise<ObserverAccountChoice[]>) {
    super()
  }

  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    return this.ask(needs)
  }
}

type Configure = (what: string, workspaceId: string, gadgetId?: number) => RpcStub<ObserverConfigCallback>

// The overseer an open gave, with its gadgets got as the user's own access asks: a collaborator on
// one gadget alone is verified when they get it, not when the workspace opens. Over the stub, so
// that it is still pipelined and disposed of as one.
const withGadgetAccess = <Overseer extends object>(overseer: Overseer, workspaceId: string, configure: Configure): Overseer =>
  new Proxy(overseer, {
    get(target, prop) {
      const value = (target as Record<PropertyKey, unknown>)[prop]
      if (prop !== 'getGadget') return value
      const getGadget = value as (id: number, given?: RpcStub<ObserverConfigCallback>) => unknown
      return (id: number, given?: RpcStub<ObserverConfigCallback>) => getGadget(id, given ?? configure('this gadget', workspaceId, id))
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
  workspaceId: string
  /** The gadget it is for, where it is for one, whose pane may ask it in place (`useAccessQuestion`). */
  gadgetId?: number
  needs: ObserverBindingNeed[]
  waiting: { resolve: (choices: ObserverAccountChoice[]) => void; reject: (error: Error) => void }[]
}

const askingKey = (workspaceId: string, needs: readonly ObserverBindingNeed[]) =>
  `${workspaceId}:${needs.map(({ gatekeeperId, failure }) => `${gatekeeperId}${failure ? '!' : ''}`).toSorted().join(',')}`

/** The workspace a page shows, by its address: its own pages, or one of its items on a page of its own. */
export const viewedWorkspace = (pathname: string): string | undefined => {
  const workspace = /^\/workspace\/([^/]+)/.exec(pathname)
  if (workspace) return decodeURIComponent(workspace[1])
  const item = /^\/(?:app|library)\/([^/]+)/.exec(pathname)
  return item ? parseItemPageId(decodeURIComponent(item[1]))?.workspaceId : undefined
}

// Forgets what the user cancelled, so that the next open asks them again.
const AskAgainContext = createContext<() => void>(() => {})

type Questions = {
  asking?: Asking
  /** Where the question is asked in place, if anywhere. */
  holder?: string
  /** Answers the question of `key`: the accounts confirmed with, or none, cancelled. */
  answer: (key: string, choices: ObserverAccountChoice[] | undefined) => void
  /** Says that what is at `place` asks what is asked of it in place, until the function it gives is called. */
  host: (place: string) => () => void
  /** Whether the user is asked, or about to be, about a gadget. */
  waiting: (workspaceId: string, gadgetId: number) => boolean
}

const QuestionsContext = createContext<Questions>({ answer: () => {}, host: () => () => {}, waiting: () => false })

/** Whether opening a gadget waits on the user, who is asked to confirm their access to it, which takes as long as it takes. */
export const useAccessWaiting = () => use(QuestionsContext).waiting

/**
 * What a gadget's pane shows while it is `loading`, where opening it, or its workspace, asks the
 * user to confirm their access: the question, as the pane (`ConfirmAccessForm`). Null while there is
 * nothing to ask. `title` is the gadget's, as the question names it.
 */
export const useAccessQuestion = (gadget: { workspaceId: string; workpieceId: number } | undefined, title: string, loading: boolean): ReactNode => {
  const { asking, holder, answer, host } = use(QuestionsContext)
  const place = gadget && placeOf(gadget.workspaceId, gadget.workpieceId)
  useEffect(() => (place && loading ? host(place) : undefined), [host, place, loading])
  if (!place || !loading || !asking || holder !== place) return null
  return <ConfirmAccess key={asking.key} what={title} needs={asking.needs} onAnswer={(choices) => answer(asking.key, choices)} />
}

/**
 * What the page beside the sidebar shows in place of what it would, where opening a workspace asks
 * the user to confirm their access and no pane of that workspace's asks it: the question, as the
 * page (`ConfirmAccessForm`), with the sidebar beside it to go elsewhere by, which leaves it
 * unanswered. It has Cancel all the same, as a page with no sidebar button on a phone, such as a
 * chat, has no other way out. Null while there is nothing to ask. Where nothing calls it, as before
 * the app's frame is there, the question is the whole window.
 */
export const usePageAccessQuestion = (): ReactNode => {
  const { asking, holder, answer, host } = use(QuestionsContext)
  useEffect(() => host(PAGE), [host])
  if (!asking || holder !== PAGE) return null
  return <ConfirmAccess key={asking.key} what={asking.what} needs={asking.needs} surface="base" cancellable onAnswer={(choices) => answer(asking.key, choices)} />
}

/** Call before opening again what the user cancelled confirming their access to, so that it is asked again. */
export const useAskAccessAgain = () => use(AskAgainContext)

/**
 * Beneath `RpcGate`: the API for everything below, ready to ask the user to confirm their access
 * (`withObserverAccess`), and what asks (`ConfirmAccess`), one question at a time: as the pane of
 * the gadget it is for (`useAccessQuestion`), or, for a workspace, as the page beside the sidebar
 * (`usePageAccessQuestion`), else the whole window. What the user cancels is not asked again, as it
 * is opened again and again in the background, until they ask for it (`useAskAccessAgain`).
 */
export const ObserverAccessProvider = ({ children, viewing: shown }: {
  children: ReactNode
  /** The workspace on screen, where the address does not name it, as on a development page. */
  viewing?: string
}) => {
  const session = useApi()
  const queue = useRef<Asking[]>([])
  const declined = useRef(new Set<string>())
  // What is asked, as of the last change to the queue, for rendering.
  const [queued, setQueued] = useState<readonly Asking[]>([])
  const changed = () => setQueued([...queue.current])
  // The panes that ask in place, and the page, each as many times as it is shown.
  const [hosts, setHosts] = useState<readonly string[]>([])
  const host = useCallback((place: string) => {
    setHosts((was) => [...was, place])
    return () => setHosts((was) => {
      const at = was.indexOf(place)
      return at === -1 ? was : was.toSpliced(at, 1)
    })
  }, [])
  const waiting = useCallback((workspaceId: string, gadgetId: number) =>
    queue.current.some((each) => each.workspaceId === workspaceId && each.gadgetId === gadgetId), [])

  // Only what is on screen asks: the sidebar's counts and what the gadgets ask open the user's
  // recent workspaces in the background, which would otherwise ask of them unbidden, wherever they
  // are. Those are refused as not asked, as an open with nothing to ask is; so is what the user
  // cancelled, until they ask again. The overseer refuses the open with the code it is answered.
  const viewing = useRef<string | undefined>(undefined)
  const addressed = useRouterState({ select: ({ location }) => viewedWorkspace(location.pathname) })
  viewing.current = shown ?? addressed
  const ask = useCallback((what: string, workspaceId: string, gadgetId: number | undefined, needs: ObserverBindingNeed[]) => new Promise<ObserverAccountChoice[]>((resolve, reject) => {
    const key = askingKey(workspaceId, needs)
    if (workspaceId !== viewing.current || declined.current.has(key)) {
      return reject(createAccessConfirmationError(ACCESS_CONFIRMATION_ERROR_CODES.notAsked))
    }
    const same = queue.current.find((each) => each.key === key)
    if (same) return void same.waiting.push({ resolve, reject })
    queue.current.push({ key, what, workspaceId, gadgetId, needs, waiting: [{ resolve, reject }] })
    changed()
  }), [])

  const answer = useCallback((key: string, choices: ObserverAccountChoice[] | undefined) => {
    const at = queue.current.findIndex((each) => each.key === key)
    if (at === -1) return
    const [done] = queue.current.splice(at, 1)
    if (!choices) declined.current.add(done.key)
    for (const { resolve, reject } of done.waiting) {
      if (choices) resolve(choices)
      else reject(createAccessConfirmationError(ACCESS_CONFIRMATION_ERROR_CODES.cancelled))
    }
    changed()
  }, [])

  const askAgain = useCallback(() => declined.current.clear(), [])

  // Going to another workspace leaves what was asked of this one unanswered, which is not to decline
  // it: coming back asks again.
  const onScreen = shown ?? addressed
  useEffect(() => {
    const left = queue.current.filter(({ workspaceId }) => workspaceId !== onScreen)
    if (left.length === 0) return
    queue.current = queue.current.filter(({ workspaceId }) => workspaceId === onScreen)
    for (const { waiting: waitingOn } of left) for (const { reject } of waitingOn) reject(createAccessConfirmationError(ACCESS_CONFIRMATION_ERROR_CODES.notAsked))
    changed()
  }, [onScreen])

  const { api } = session
  const wrapped = useMemo(() => withObserverAccess(api, (what, workspaceId, gadgetId) => new ObserverConfig((needs) => ask(what, workspaceId, gadgetId, needs)) as unknown as RpcStub<ObserverConfigCallback>), [api, ask])
  const value = useMemo(() => ({ ...session, api: wrapped }), [session, wrapped])
  const asking = askable(queued, hosts)
  const holder = asking && holderOf(asking, hosts)
  const questions = useMemo<Questions>(() => ({ asking, holder, answer, host, waiting }), [asking, holder, answer, host, waiting])
  // A workspace's asked where nothing else can ask it, before the app's frame is there (a shared
  // link being let in by), is the whole window, as the first run is: what is there stays under it,
  // out of sight, so that what waits on the answer is there to have it.
  const whole = asking !== undefined && holder === undefined

  return (
    <ApiContext value={value}>
      <AskAgainContext value={askAgain}>
        <QuestionsContext value={questions}>
          {/* The same element either way, so that the app is not made again as it is hidden and shown. */}
          <div inert={whole} className={whole ? 'hidden' : 'contents'}>{children}</div>
          {whole && (
            <div className="flex h-full flex-col bg-kumo-canvas">
              <ConfirmAccess key={asking.key} what={asking.what} needs={asking.needs} surface="canvas" cancellable onAnswer={(choices) => answer(asking.key, choices)} />
            </div>
          )}
        </QuestionsContext>
      </AskAgainContext>
    </ApiContext>
  )
}

// An account by the name the user knows it by, as its row in the dialog says it.
const accountNamed = (account: ConnectedAccount | undefined) =>
  (account && (accountLabel(account.description) ?? account.vendor.displayName)) ?? 'The account chosen'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What keeps the account chosen from doing, the first that applies: signed out, then not given the
 * access needed, then refused, which is only while it is the account that was refused.
 */
const issueOf = (
  account: ConnectedAccount | undefined,
  missing: readonly string[],
  missingNames: string[],
  refusal: string | undefined,
  { signIn, grant, pending }: { signIn: () => void; grant: () => void; pending: boolean },
): ConfirmAccessIssue | undefined => {
  if (!account) return undefined
  if (!account.credentialsValid) return { kind: 'signed-out', signIn: { pending, onSelect: signIn } }
  if (missing.length > 0) return { kind: 'needs-access', missing: missingNames, grant: { pending, onSelect: grant } }
  if (refusal !== undefined) return { kind: 'refused', reason: refusal }
  return undefined
}

type ConfirmAccessProps = {
  what: string
  /** What it is drawn on: a gadget's pane, the page, or the window. */
  surface?: 'tint' | 'base' | 'canvas'
  needs: ObserverBindingNeed[]
  /** The accounts confirmed with, for every connection asked about; or none, cancelled. */
  onAnswer: (choices: ObserverAccountChoice[] | undefined) => void
  /** It can be put away without confirming, as where it is the whole window, which has no other way out. */
  cancellable?: boolean
}

/**
 * The question (`ConfirmAccessForm`) over what it asks about: the user's accounts, kept up to date
 * as one is connected in a window of its own, the services, for their logos and what each grants,
 * and each resource once with the account chosen for it, which answers every connection that reads it.
 */
const ConfirmAccess = ({ what, surface, needs, onAnswer, cancellable = false }: ConfirmAccessProps) => {
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
      accounts: theirs.map((each) => ({ id: each.id, name: accountNamed(each), expired: !each.credentialsValid })),
      chosen: account?.id,
      ready: accountWillDo(resource, vendor, account),
      issue: issueOf(account, missing, accessNames(missing, vendor, account), account?.id === refused ? failure?.reason : undefined, {
        signIn: () => account && during(resource.key, async () => openConnectWindow(await api.reconnectAccount(account.id))),
        grant: () => account && during(resource.key, async () => {
          const flow = await api.ensureAccountResources(account.id, missing)
          if (flow) openConnectWindow(flow)
          else setGranted((current) => new Map(current).set(account.id, [...(current.get(account.id) ?? []), ...missing]))
        }),
        pending: pending === resource.key,
      }),
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

  return (
    <ConfirmAccessForm
      what={what}
      again={needs.some(({ failure }) => failure)}
      rows={rows}
      problem={problem}
      surface={surface}
      onChoose={(key, accountId) => setPicked((current) => new Map(current).set(key, accountId))}
      onConfirm={() => {
        const choices = resources && accountChoices(resources, chosen)
        if (choices) onAnswer(choices)
      }}
      onCancel={cancellable ? () => onAnswer(undefined) : undefined}
    />
  )
}
