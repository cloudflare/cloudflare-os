import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { ApiSession } from '@/rpc/ApiContext'
import type { TemplateReader } from '@/rpc/PublicApiContext'
import { exampleSkillsBackend } from '@/skills/MemorySkillsBackend'
import { MockBilling } from './MockBilling'
import { MOCK_WORKSPACE_ID, MockOverseer } from './MockOverseer'
import { AGENT, TEMPLATE, VIEWER, type Scenario } from './scenario'

export { MOCK_WORKSPACE_ID }

/**
 * A signed-in API for one scenario, to provide through `ApiContext` where the real one would be.
 * Only what a chat and its workspace's page need is implemented; any other call throws, so a screen that starts depending
 * on more says so instead of hanging.
 */
export const createMockApi = (scenario: Scenario): { session: ApiSession; overseer: MockOverseer; publicApi: TemplateReader } => {
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
    listWorkspaces: async () => (overseer.deleted || dismissed ? [] : [workspace]),
    dismissSharedWorkspace: async () => {
      dismissed = true
    },
    // An empty library: what a scenario makes is listed from its chat, as a pending gadget is.
    listOutputs: async () => ({ outputs: [], catchingUp: false }),
    // The example skills, kept as the Context Library would keep them, for a new chat's composer.
    // No other gatekeeper has an app here, the scheduler included: automations show without when
    // they run.
    ...exampleSkillsBackend().asApi(),
    // No services and no accounts: a pasted link stays as it was written.
    listGatekeeperVendors: async () => [],
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
  // What anyone may read: here, the one template the scenarios' gadget follows.
  const publicApi: TemplateReader = { getBlueprint: async (id) => (id === TEMPLATE.id ? TEMPLATE : null) }
  return { session: { api: api as unknown as ApiSession['api'], user: VIEWER, userChanged: () => {}, reconnecting: false }, overseer, publicApi }
}
