import type { OutputsSubscriber, OwnBlueprintsSubscriber, WorkspaceMetadataWithTimestamps, WorkspacesSubscriber } from '@gadgets/workshop-shared/api'
import type { ApiSession } from '@/rpc/ApiContext'
import type { TemplateReader } from '@/rpc/PublicApiContext'
import { MockBilling } from './MockBilling'
import { MOCK_WORKSPACE_ID, MockOverseer } from './MockOverseer'
import { AGENT, TEMPLATE, VIEWER, type Scenario } from './scenario'

export { MOCK_WORKSPACE_ID }

/**
 * A signed-in API for one scenario, to provide through `ApiContext` where the real one would be.
 * Only what a chat and its workspace's page need is implemented; any other call throws, so a screen that starts depending
 * on more says so instead of hanging.
 */
export const createMockApi = (scenario: Scenario): { session: ApiSession; publicApi: TemplateReader; overseer: MockOverseer } => {
  const overseer = new MockOverseer(scenario)
  const billing = new MockBilling()
  const workspace: WorkspaceMetadataWithTimestamps = {
    id: MOCK_WORKSPACE_ID,
    title: scenario.title,
    created: new Date(0),
    lastActive: new Date(),
    containsRestrictedData: scenario.restricted,
    owner: scenario.owner,
  }
  // Removed from the viewer's list, as one shared with them can be; they keep their access.
  let dismissed = false
  // Whoever listens to the list, told once the workspace has left it.
  const listeners = new Set<WorkspacesSubscriber>()
  const leave = () => listeners.forEach((listener) => void listener.updated(MOCK_WORKSPACE_ID, null))
  overseer.onDeleted = leave
  const implemented: Record<string | symbol, unknown> = {
    openWorkspace: () => overseer.open(),
    // The viewer's notifications for the one chat, which its header's more changes.
    subscribeToUnreadState: (_scope: unknown, subscriber: Parameters<MockOverseer['subscribeToReadState']>[1]) =>
      overseer.subscribeToReadState(MOCK_WORKSPACE_ID, subscriber),
    markWorkspaceRead: () => overseer.markWorkspaceRead(),
    getUnreadThreads: async () => overseer.unreadThreads(MOCK_WORKSPACE_ID),
    listModels: async () => [AGENT],
    getPreferredModel: async () => null,
    // Until it has deleted itself or been removed from the list.
    subscribeToWorkspaces: async (subscriber: WorkspacesSubscriber) => {
      listeners.add(subscriber)
      void subscriber.snapshot(overseer.deleted || dismissed ? [] : [workspace])
      return { [Symbol.dispose]: () => listeners.delete(subscriber) }
    },
    dismissSharedWorkspace: async () => {
      dismissed = true
      leave()
    },
    // An empty library: what a scenario makes is listed from its chat, as a pending gadget is.
    subscribeToOutputs: async (subscriber: OutputsSubscriber) => {
      void subscriber.snapshot([], false)
      return { [Symbol.dispose]: () => {} }
    },
    // No services and no accounts: a pasted link stays as it was written.
    listGatekeeperVendors: async () => [],
    listAddableGatekeepers: async () => [],
    // The free requests used up, for a chat that runs out of them; Cloudflare is the one service
    // that can be connected, which it is at once.
    getCloudflareUsage: async () => billing.usage(),
    listCloudflareAccounts: async () => billing.accounts(),
    selectCloudflareAccount: async (accountId: string) => billing.select(accountId),
    connectAccount: async (vendorId: string) => {
      if (vendorId !== 'cloudflare') throw new Error(`not mocked: connecting ${vendorId}`)
      return billing.connect()
    },
    subscribeConnectedAccounts: (subscriber: { ready: () => void }) => {
      subscriber.ready()
      return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
    },
    // The scenarios do not publish or save templates in the viewer's account.
    subscribeToOwnBlueprints: async (subscriber: OwnBlueprintsSubscriber) => {
      await subscriber.snapshot([])
      return { [Symbol.dispose]: () => {} }
    },
    listFeaturedBlueprints: async () => [],
    listLibraryBlueprints: async () => [],
    // Nothing to start with, so the composer offers none as it is written in.
    listOutputFormats: async () => [],
  }
  const api = new Proxy(implemented, {
    get: (target, name) => {
      // Not a promise, and nothing to dispose.
      if (name in target || typeof name === 'symbol' || name === 'then') return target[name]
      return () => {
        throw new Error(`not mocked: ${name}`)
      }
    },
  })
  // The real API is an RPC stub whose every call is a pipelined promise; the fake answers with
  // plain objects, which is all the app awaits.
  return {
    session: { api: api as unknown as ApiSession['api'], user: VIEWER, userChanged: () => {}, reconnecting: false },
    // The one published template the scenarios' gadgets can follow.
    publicApi: { getBlueprint: async (id) => id === TEMPLATE.id ? TEMPLATE : null },
    overseer,
  }
}
