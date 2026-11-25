import type { ChatConnectionUse } from '@gadgets/workshop-shared/api'

/** One thing a chat can reach on a service, once however many connections reach it. */
export type ChatConnector = {
  key: string
  /**
   * The service (`GatekeeperVendorInfo.id`), by which its name, logo and kinds are found. Absent
   * for a connection that has none, as a model's, which is a connector of its own.
   */
  vendorId?: string
  /** Which one it is, as its connection was titled when made; absent for a whole account. */
  title?: string
  /** Its address, by which its kind is found where its kind is not known. */
  resourceUrl?: string
  /** Its kind (`SupportedResource.id`), where known. */
  resourceTypeId?: string
}

/** A connection, as `chatConnectors` takes it: as a chat used it, with its kind where that is known. */
export type ConnectorSource = ChatConnectionUse & { resourceTypeId?: string }

/**
 * What `connections` reach, each once, in the order they come: two connections to the same thing
 * on a service, by its address or else its title, are one, which takes what either says of it. A
 * connection with no service is one of its own.
 */
export const chatConnectors = (connections: readonly ConnectorSource[]): ChatConnector[] => {
  const found = new Map<string, ChatConnector>()
  for (const { gatekeeperId, vendorId, resourceTitle, resourceUrl, resourceTypeId } of connections) {
    const key = vendorId === undefined ? `connection:${gatekeeperId}` : `${vendorId}:${resourceUrl ?? resourceTitle ?? ''}`
    const known = found.get(key)
    found.set(key, {
      key,
      vendorId,
      title: known?.title ?? (resourceTitle || undefined),
      resourceUrl: known?.resourceUrl ?? resourceUrl,
      resourceTypeId: known?.resourceTypeId ?? resourceTypeId,
    })
  }
  return [...found.values()]
}
