import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { RpcPromise } from 'capnweb'
import type { ConnectFlowStart, GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ComposerHandle, ComposerLinks } from '@/blocks/Composer'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import type { AddedConnection } from '@/connections/AddConnection'
import { openConnectWindow } from '@/connections/connectHandoff'
import { accountLabel, newAccountOf, type Connection } from '@/connections/connectionList'
import { linkAccountOf, linkStanding, type LinkAccount, type LinkStanding } from '@/connections/linkStanding'
import type { ConnectResourceProps } from '@/connections/SetUpConnection'
import { useConnections } from '@/connections/useConnections'
import { useHandler } from '@/hooks/useHandler'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

/** A link found in a draft, and how far it has come to being a connection. */
type Link = {
  url: string
  /** The account chosen for it, where there was more than one it could go through. */
  accountId?: number
  /** The accounts there were when another was asked for, so that the one that comes is the one it goes through. */
  before?: ReadonlySet<number>
  /** A window of its service's was opened for it, which it waits on. */
  waiting?: boolean
  /** Why that window could not be opened. */
  problem?: string
  /** It is being made through that account; or was, and is called `title`; or why it could not be. */
  made?: { accountId: number; title?: string; problem?: string }
}

/** A link with a service that knows it, and the account it goes through, once that is settled. */
type Stood = { link: Link; standing: LinkStanding; account?: LinkAccount }

/** What is drawn for the links of a draft: their lines for its composer, and a service's form while one is chosen in it. */
export type LinkConnections = {
  draft: ComposerLinks
  /** The form of the service a link could not be connected on, to choose it in, filled in with the link. */
  form?: ConnectResourceProps
}

const NONE: readonly Connection[] = []
// Another account than those there are, among the accounts to choose from.
const ANOTHER = 'another'

const keyOf = (url: string) => `link:${url}`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const serviceOf = ({ vendor }: LinkStanding) => ({ name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color })

/**
 * Makes the links in a draft connections, as the old Workshop made a link a capsule, each a line
 * above the draft that carries what is left to decide (`ComposerConnectionLines`). One a service
 * knows as a kind of resource of its own (`linkStanding`) is made in the workspace at once
 * (`newGatekeeper`) where one account of the user's can take it: connecting, then what it is, its
 * name taking the link's place in the words. Otherwise its line offers what stands in the way:
 * connecting the service, signing in to an account again, giving it access, or choosing among
 * several, and it carries on by itself once that is done in the service's window. One that could
 * not be made says why, and offers the service's form to choose it in. A link no service knows
 * gets no line and stays as written, as does one whose line is taken off, which puts the link
 * back in the words.
 *
 * A connection made goes with the message as one added from the + menu does, through `added`.
 * Where the workspace is still to be made (`ensureWorkspace`), it is made as the first link is
 * connected, never for one that only waits. Undefined where there is neither.
 */
export const useLinkConnections = (
  workspaceId: string | undefined,
  composer: RefObject<ComposerHandle | null>,
  added: RefObject<Map<string, AddedConnection>>,
  ensureWorkspace?: () => Promise<void>,
): LinkConnections | undefined => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const { state } = useConnections()
  const connections = state.status === 'ready' ? state.connections : NONE
  const [links, setLinks] = useState<readonly Link[]>([])
  // The link whose service's form is shown, which stays as it closes.
  const [form, setForm] = useState<{ url: string; open: boolean }>()
  // Those being made, each by what tells its making from one started again after it was taken off.
  const making = useRef(new Map<string, object>())

  const change = (url: string, next: Partial<Link>) =>
    setLinks((current) => current.map((link) => (link.url === url ? { ...link, ...next } : link)))

  // Each link a service knows; one found before the services are read gets its line once they are.
  const stood = useMemo(() => links.flatMap((link): Stood[] => {
    const standing = linkStanding(connections, link.url)
    if (!standing) return []
    // One asked for in the service's window is the one meant, once it comes.
    const arrived = link.before && newAccountOf(standing.accounts.map(({ account }) => account), standing.vendorId, link.before)
    return [{ link, standing, account: linkAccountOf(standing, link.accountId ?? arrived?.id) }]
  }), [links, connections])
  // Those with nothing in the way, not yet tried.
  const wanted = stood.filter(({ link, account }) => !link.made && account && !account.needs)

  // Makes `resourceUrl` a connection in `workspace` through the account, as much of it as is shown.
  const connect = async (workspace: string, standing: LinkStanding, accountId: number, resourceUrl: string): Promise<AddedConnection> => {
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspace)
    // Typed as nullable, but never null: it throws instead. Pipelined, so what it is comes with it.
    const gatekeeper = overseer.newGatekeeper(accountId, resourceUrl) as RpcPromise<GatekeeperClient<never>>
    try {
      const [gatekeeperId, description] = await Promise.all([gatekeeper.getId(), gatekeeper.describe()])
      return { gatekeeperId, workspaceId: workspace, source: { accountId, resourceUrl }, description, vendorId: standing.vendorId, service: serviceOf(standing), kind: standing.resource.title }
    } catch (error) {
      // One made but not described is no use to anyone: it goes, as the old Workshop's did.
      gatekeeper.remove().catch(() => {})
      throw error
    } finally {
      gatekeeper[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  // The link is that connection from here on: it goes with the draft, named in its words.
  const settle = (url: string, connection: AddedConnection, accountId: number) => {
    added.current.set(keyOf(url), connection)
    change(url, { made: { accountId, title: connection.description.title } })
    composer.current?.replaceInDraft(url, connection.description.title)
  }

  const make = async (workspace: string, { link: { url }, standing }: Stood, accountId: number) => {
    const mine = {}
    making.current.set(url, mine)
    change(url, { made: { accountId } })
    try {
      const connection = await connect(workspace, standing, accountId, url)
      if (making.current.get(url) === mine) settle(url, connection, accountId)
    } catch (error) {
      if (making.current.get(url) === mine) change(url, { made: { accountId, problem: messageOf(error) } })
    } finally {
      if (making.current.get(url) === mine) making.current.delete(url)
    }
  }

  const start = useHandler(() => {
    if (workspaceId === undefined) {
      // The workspace comes as `workspaceId` once it is made, which starts them.
      ensureWorkspace?.().catch((error: unknown) => {
        const failed = new Map(wanted.map(({ link, account }) => [link.url, account!.account.id]))
        setLinks((current) => current.map((link) => {
          const accountId = failed.get(link.url)
          return accountId === undefined || link.made ? link : { ...link, made: { accountId, problem: messageOf(error) } }
        }))
      })
      return
    }
    for (const each of wanted) if (!making.current.has(each.link.url)) void make(workspaceId, each, each.account!.account.id)
  })
  // By what is wanted rather than when: an account connected in a window of the service's arrives
  // on its own, and its link carries on from there.
  const wantedKey = wanted.map(({ link, account }) => `${link.url} ${account!.account.id}`).join('\n')
  useEffect(() => {
    if (wantedKey) start()
  }, [wantedKey, workspaceId, start])

  // Opens a window of the service's for the link, which waits on what is done there.
  const open = async (url: string, flow: () => Promise<ConnectFlowStart | null>, before?: ReadonlySet<number>) => {
    if (notice?.blocked()) return
    change(url, { waiting: true, problem: undefined, before })
    try {
      const started = await flow()
      if (started) openConnectWindow(started)
      // Nothing to ask: the account has it already, and says so itself.
      else change(url, { waiting: false })
    } catch (error) {
      change(url, { waiting: false, problem: `Couldn’t open it: ${messageOf(error)}` })
    }
  }

  // What the line of a link offers, whichever it is.
  const act = useHandler((url: string, choice?: string) => {
    const found = stood.find(({ link }) => link.url === url)
    if (!found) return
    const { link, standing, account } = found
    if (link.made?.problem !== undefined) {
      // Chosen in the service's form, which needs the workspace; without one, tried again.
      if (workspaceId === undefined) change(url, { made: undefined })
      else setForm({ url, open: true })
    } else if (choice !== undefined && choice !== ANOTHER) change(url, { accountId: Number(choice), before: undefined, waiting: false, problem: undefined })
    else if (!account || choice === ANOTHER) {
      // Only what the link needs, where the service gives access to each kind on its own.
      void open(url, () => api.connectAccount(standing.vendorId, standing.asks.length > 0 ? standing.asks : undefined), new Set(standing.accounts.map(({ account: each }) => each.id)))
    } else if (account.needs?.kind === 'signIn') void open(url, () => api.reconnectAccount(account.account.id))
    else if (account.needs?.kind === 'access') {
      const { patterns } = account.needs
      void open(url, () => api.ensureAccountResources(account.account.id, patterns))
    }
  })

  const lines = useMemo(() => stood.map(({ link, standing, account }): ComposerConnection => {
    const { url, made } = link
    const name = standing.vendor.displayName
    const kind = standing.resource.title
    const line = { key: keyOf(url), title: kind, kind, service: serviceOf(standing) }
    const ask = (label: string) => ({ label, onAct: () => act(url) })
    // What it waits on, unless the window that would have asked could not be opened.
    const waits = (note: string) => ({ problem: link.problem, note: link.waiting ? `Finish in ${name}’s window` : note })
    if (made?.title !== undefined) return { ...line, title: made.title }
    if (made?.problem !== undefined) return { ...line, problem: `Couldn’t connect it: ${made.problem}`, ask: ask(workspaceId === undefined ? 'Try again' : 'Choose…') }
    if (made) return { ...line, pending: true }
    if (standing.accounts.length === 0) return { ...line, ...waits(`Connect ${name} to add it`), ask: ask('Connect') }
    if (!account) {
      return {
        ...line,
        ...waits('Which account?'),
        ask: {
          label: 'Choose account',
          choices: [
            ...standing.accounts.map(({ account: each }) => ({ id: String(each.id), label: accountLabel(each.description) ?? name })),
            ...(standing.takesAnother ? [{ id: ANOTHER, label: 'Another account…' }] : []),
          ],
          onChoose: (id) => act(url, id),
        },
      }
    }
    // Which account, where it is one of several.
    const whose = (standing.accounts.length > 1 && accountLabel(account.account.description)) || name
    if (account.needs?.kind === 'signIn') return { ...line, ...waits(`Sign in to ${whose} again to add it`), ask: ask('Sign in') }
    if (account.needs?.kind === 'access') return { ...line, ...waits(`Give access on ${whose} to add it`), ask: ask('Give access') }
    // About to be made: the draft waits for it from the start.
    return { ...line, pending: true }
  }), [stood, workspaceId, act])

  const onFound = useHandler((urls: string[]) => {
    setLinks((current) => [...current, ...urls.filter((url) => !current.some((link) => link.url === url)).map((url) => ({ url }))])
  })
  const onRemove = useHandler((key: string) => {
    const link = links.find(({ url }) => keyOf(url) === key)
    if (!link) return
    // One being made is not wanted once it is: its making no longer counts.
    making.current.delete(link.url)
    added.current.delete(key)
    setLinks((current) => current.filter((each) => each !== link))
    // The link is what was written, so it is again.
    if (link.made?.title !== undefined) composer.current?.replaceInDraft(link.made.title, link.url)
  })
  // The message went with those that were made; the rest went as the links they are.
  const onSent = useHandler(() => {
    making.current.clear()
    setLinks([])
  })
  const draft = useMemo(() => ({ lines, onFound, onRemove, onSent }), [lines, onFound, onRemove, onSent])

  if (workspaceId === undefined && !ensureWorkspace) return undefined
  const choosing = form && stood.find(({ link }) => link.url === form.url)
  return {
    draft,
    form: choosing && workspaceId !== undefined ? {
      open: form.open,
      onOpenChange: (next) => setForm({ url: form.url, open: next }),
      vendorId: choosing.standing.vendorId,
      name: choosing.standing.vendor.displayName,
      logoUrl: choosing.standing.vendor.logo?.url,
      resourceUrlPattern: choosing.standing.resource.urlPattern,
      resourceUrl: form.url,
      resource: choosing.standing.resource.title,
      onConnect: async (accountId, resourceUrl) => settle(form.url, await connect(workspaceId, choosing.standing, accountId, resourceUrl), accountId),
    } : undefined,
  }
}
