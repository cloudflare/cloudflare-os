import type { RefObject } from 'react'
import type { RpcPromise } from 'capnweb'
import type { GatekeeperClient } from '@gadgets/workshop-shared/api'
import type { ComposerHandle } from '@/blocks/Composer'
import type { AddedConnection } from '@/connections/AddConnection'
import { useConnections } from '@/connections/useConnections'
import { linkAccount } from '@/connections/linkAccount'
import { useApi } from '@/rpc/ApiContext'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Turns the links pasted into a draft into connections, as the old Workshop made a pasted link a
 * capsule: each one of the user's accounts knows as a kind of resource of its own (`linkAccount`)
 * is made in the workspace at once (`newGatekeeper`), shown above the draft as connecting, then as
 * what it is, its name taking the link's place in the words; or why it could not be, the link
 * left as written. It goes with the message as one added from the + menu does, through `added`.
 * Undefined where there is no workspace to make it in, or the viewer may not build in it.
 */
export const useLinkConnections = (
  workspaceId: string | undefined,
  composer: RefObject<ComposerHandle | null>,
  added: RefObject<Map<string, AddedConnection>>,
) => {
  const { api } = useApi()
  const { state } = useConnections()
  if (workspaceId === undefined) return undefined

  const connect = async (url: string) => {
    if (state.status !== 'ready') return
    const match = linkAccount(state.connections.flatMap((each) => (each.kind === 'account' ? [each.account] : [])), url)
    if (!match) return
    const { account, resource } = match
    const service = { name: account.vendor.displayName, logoUrl: account.vendor.logo?.url, color: account.vendor.color }
    const key = `link:${url}`
    composer.current?.addConnection({ key, title: resource.title, kind: resource.title, service, pending: true })
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    // Typed as nullable, but never null: it throws instead. Pipelined, so what it is comes with it.
    const gatekeeper = overseer.newGatekeeper(account.id, url) as RpcPromise<GatekeeperClient<never>>
    try {
      const [gatekeeperId, description] = await Promise.all([gatekeeper.getId(), gatekeeper.describe()])
      added.current.set(key, { gatekeeperId, description, vendorId: account.vendorId, service, kind: resource.title })
      composer.current?.addConnection({ key, title: description.title, kind: resource.title, service })
      composer.current?.replaceInDraft(url, description.title)
    } catch (error) {
      composer.current?.addConnection({ key, title: resource.title, kind: resource.title, service, problem: `Couldn’t connect it: ${messageOf(error)}` })
      // One made but not described is no use to anyone: it goes, as the old Workshop's did.
      gatekeeper.remove().catch(() => {})
    } finally {
      gatekeeper[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  return (urls: string[]) => {
    for (const url of urls) void connect(url)
  }
}
