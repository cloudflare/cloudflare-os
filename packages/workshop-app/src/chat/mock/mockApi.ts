import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { ApiSession } from '@/rpc/ApiContext'
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
  const workspace: WorkspaceMetadataWithTimestamps = {
    id: MOCK_WORKSPACE_ID,
    title: scenario.title,
    created: new Date(0),
    lastActive: new Date(),
    containsRestrictedData: scenario.restricted,
  }
  const implemented: Record<string | symbol, unknown> = {
    openWorkspace: () => overseer,
    listModels: async () => [AGENT],
    listWorkspaces: async () => [workspace],
    // An empty library: what a scenario makes is listed from its chat, as a pending gadget is.
    listOutputs: async () => ({ outputs: [], catchingUp: false }),
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
  return { session: { api: api as unknown as ApiSession['api'], user: VIEWER }, overseer }
}
