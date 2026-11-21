/**
 * Where an address of the old Workshop goes now, so that links people kept, and those the server
 * still sends in notifications and emails, land somewhere sensible. Undefined for an address that
 * is current.
 */
export type LegacyTarget = { href: string }

const id = (value: unknown) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

/** Pages of the old Workshop that are a page of their own here too, under another name. */
const RENAMED: Record<string, string> = {
  '/blueprints': '/library/templates',
  '/explore': '/library/templates',
  '/outputs': '/library',
  '/context': '/library',
  '/gatekeepers': '/connections',
  '/providers': '/connections',
  '/profile': '/settings',
  '/unread': '/',
}

export const legacyTarget = (pathname: string, search: Record<string, unknown>): LegacyTarget | undefined => {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (RENAMED[path]) return { href: RENAMED[path] }
  // A gatekeeper's app was at /gatekeepers/<id>.
  const app = /^\/gatekeepers\/([^/]+)$/.exec(path)
  if (app) return { href: `/apps/${app[1]}` }

  const template = /^\/blueprint\/([^/]+)$/.exec(path)
  if (template) return { href: `/library/templates/${template[1]}` }

  // A workspace was once at /gadget/<id>, and a chat in it was ?chat=, with ?w= the gadget shown
  // beside it. `showChat` only said to show the chat, which a chat's own page does.
  const workspace = /^\/(?:gadget|workspace)\/([^/]+)$/.exec(path)
  if (!workspace) return undefined
  const workspaceId = workspace[1]!
  const chat = id(search.chat)
  const open = id(search.w)
  const query = open === undefined ? '' : `?open=${open}`
  if (chat !== undefined) return { href: `/workspace/${workspaceId}/chat/${chat}${query}` }
  if (path.startsWith('/gadget/') || open !== undefined) return { href: `/workspace/${workspaceId}${query}` }
  return undefined
}
