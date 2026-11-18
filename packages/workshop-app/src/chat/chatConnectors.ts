import type { ChatItem } from './chatItems'

/** A service a chat has used, once for each, with what of it. */
export type ChatConnector = {
  key: string
  name: string
  logoUrl?: string
  /** What was connected of it, such as the files or addresses it was asked for, each once. */
  scopes: string[]
}

const WEB = 'web'

/**
 * The services a chat has used, most recently first, as its conversation shows: the connections it
 * asked for that were made, by service, and the web, once it was let fetch a page.
 *
 * This is a stand-in. Only what has been loaded of the conversation is read, and a connection the
 * workspace already had, which the agent used without asking, leaves nothing in it. Listing what a
 * chat used for real needs the backend to say it (e.g. the services its actions and tool calls
 * went through), which the workspace does not yet.
 */
export const chatConnectors = (rows: readonly ChatItem[]): ChatConnector[] => {
  const found = new Map<string, ChatConnector>()
  for (const row of rows) {
    const used =
      row.kind === 'connection' && row.state === 'connected' ? { key: row.vendorId, name: row.vendorName, logoUrl: row.logoUrl, scope: row.scope }
        : row.kind === 'webFetch' && row.state === 'approved' ? { key: WEB, name: 'Web fetch', logoUrl: undefined, scope: undefined }
          : undefined
    if (!used) continue
    const before = found.get(used.key)
    const scopes = before?.scopes ?? []
    // Set again at the end of the map as it is used again, so that the last is the latest used.
    found.delete(used.key)
    found.set(used.key, {
      key: used.key,
      name: used.name,
      logoUrl: used.logoUrl ?? before?.logoUrl,
      scopes: used.scope && !scopes.includes(used.scope) ? [...scopes, used.scope] : scopes,
    })
  }
  return [...found.values()].toReversed()
}
