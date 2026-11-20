import type { ChatConnectionUse } from '@gadgets/workshop-shared/api'

/** A service a chat has used, once for each, with what of it. */
export type ChatConnector = {
  key: string
  /**
   * The service (`GatekeeperVendorInfo.id`), by which its name and logo are found. Absent for a
   * connection that has none, as a model's, which is a connector of its own.
   */
  vendorId?: string
  /** What of it was used: what its connections reach, each once. */
  scopes: string[]
}

/**
 * The services a chat has used, by service, as its workspace says (`ChatArtifacts.connections`):
 * each connection that a read, an action or an automation of the chat went through, whether the
 * chat asked for it or the workspace already had it.
 */
export const chatConnectors = (connections: readonly ChatConnectionUse[]): ChatConnector[] => {
  const found = new Map<string, ChatConnector>()
  for (const { gatekeeperId, vendorId, resourceTitle } of connections) {
    const key = vendorId ?? `connection:${gatekeeperId}`
    const scopes = found.get(key)?.scopes ?? []
    found.set(key, { key, vendorId, scopes: resourceTitle && !scopes.includes(resourceTitle) ? [...scopes, resourceTitle] : scopes })
  }
  return [...found.values()]
}
