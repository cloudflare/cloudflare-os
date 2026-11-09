/**
 * Where a gadget's own page (full screen, or its settings) was opened from, carried in its
 * address as `?from=`, so that its close and back buttons return there rather than to wherever
 * the gadget happens to live: the Library, a workspace, a chat, or (for its settings) the gadget
 * on its own.
 */
export type AppPageOrigin = 'library' | 'workspace' | 'chat' | 'gadget'

const ORIGINS: readonly AppPageOrigin[] = ['library', 'workspace', 'chat', 'gadget']

/** The search params of a gadget's own pages. */
export type AppPageSearch = {
  /** Where the page was opened from; absent for a link followed from elsewhere. */
  from?: AppPageOrigin
}

/** Reads a gadget page's search params, dropping a `from` that isn't one of ours. */
export const validateAppPageSearch = (search: Record<string, unknown>): AppPageSearch => {
  const from = ORIGINS.find(origin => origin === search.from)
  return from ? { from } : {}
}

/** What a back button to the origin says. */
export const backToOriginLabel = (from: AppPageOrigin) =>
  from === 'library' ? 'Back to Library' : from === 'workspace' ? 'Back to workspace'
    : from === 'gadget' ? 'Back to gadget' : 'Back to chat'
