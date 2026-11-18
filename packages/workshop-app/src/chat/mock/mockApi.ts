import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { ApiSession } from '@/rpc/ApiContext'
import { exampleSkillsBackend } from '@/skills/MemorySkillsBackend'
import { MockBilling } from './MockBilling'
import { MockOverseer } from './MockOverseer'
import { AGENT, VIEWER, type Scenario } from './scenario'

/** The one workspace the fake API lists. */
export const MOCK_WORKSPACE_ID = 'mock'

/**
 * A signed-in API for one scenario, to provide through `ApiContext` where the real one would be.
 * Only what a chat needs is implemented; any other call throws, so a screen that starts depending
 * on more says so instead of hanging.
 */
export const createMockApi = (scenario: Scenario): { session: ApiSession; overseer: MockOverseer } => {
  const overseer = new MockOverseer(scenario)
  const billing = new MockBilling()
  const workspace: WorkspaceMetadataWithTimestamps = {
    id: MOCK_WORKSPACE_ID,
    title: scenario.title,
    created: new Date(0),
    lastActive: new Date(),
    containsRestrictedData: scenario.restricted,
  }
  const implemented: Record<string | symbol, unknown> = {
    openWorkspace: () => overseer.open(),
    listModels: async () => [AGENT],
    getPreferredModel: async () => null,
    listWorkspaces: async () => [workspace],
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
  return { session: { api: api as unknown as ApiSession['api'], user: VIEWER, userChanged: () => {}, reconnecting: false }, overseer }
}
