import type { BlueprintOutput, ChatFileSummary, FavoriteItem, FavoriteItemRef, FavoriteItemSpec, LibraryItemRef, OutputSummary } from '@gadgets/workshop-shared/api'
import { formatAsideRef, type AsideItem } from '@/aside/asideItems'
import type { ArrangedGroup } from '@/components/listView'
import { formatActivity } from '@/workspaces/formatActivity'
import { byStarOrder } from './libraryStars'
import type { ConnectedFile } from './connectedFiles'
import { waitingOn } from './Waiting'

/** What the Library page shows, a tab each. */
export type LibraryTab = 'favorites' | 'gadgets' | 'files'

/** How a list is ordered: latest first, grouped by when, or by name. */
export type LibrarySort = 'recent' | 'name'

/** A file sent in a chat, with the workspace it is in. */
export type WorkspaceFile = ChatFileSummary & { workspaceId: string; workspaceTitle?: string }

/** One thing in the Library: what opens, and what can be done with it here. */
export type LibraryEntry = {
  /** Tells it from everything else in the Library, across workspaces. */
  key: string
  /** What opens, beside the page or as a page of its own. */
  item: AsideItem
  /** Made, as a gadget is; or a file, sent in a chat or kept by a connected service. */
  section: 'gadget' | 'file'
  title: string
  /** The format a gadget was made as, where it was made as one. */
  output?: BlueprintOutput
  /** When it was last worked on, sent or starred, whichever the Library knows of. */
  at: Date
  workspaceId: string
  workspaceTitle?: string
  /** Whoever shared it, when it is someone else's. */
  sharedBy?: string
  /** The chat a file was sent or last worked on in, which its own page is shown from. */
  chatId?: number
  /** How it is starred, when it can be: anything but a chat, which is starred in its workspace. */
  favorite?: FavoriteItemSpec
  starred: boolean
  /** How it is taken out of the Library. */
  removal: LibraryItemRef
  /** The viewer builds in its workspace, so may share, rename or delete it. Only a gadget can be. */
  builds: boolean
  /** How many changes it has waiting on the viewer to approve: only a gadget's, and only theirs to decide. */
  waiting?: number
}

/** Everything the Library is made from. */
export type LibrarySources = {
  outputs: readonly OutputSummary[]
  files: readonly WorkspaceFile[]
  connected: readonly (ConnectedFile & { workspaceTitle?: string })[]
  /** The viewer's starred items, latest starred first. */
  favorites: readonly FavoriteItem[]
  /** What the viewer took out, by `removalKey`, with when. */
  removals: ReadonlyMap<string, Date>
  /** The workspaces the viewer builds in. */
  builds: ReadonlySet<string>
}

/** The key a starred item is known by, as the server knows it (`favoriteKey`). */
export const favoriteKey = (ref: FavoriteItemRef) =>
  ref.kind === 'app' ? `${ref.workspaceId}:app:${ref.workpieceId}`
    : ref.kind === 'chat' ? `${ref.workspaceId}:chat:${ref.chatId}`
      : ref.kind === 'external' ? `${ref.workspaceId}:external:${ref.subjectId}`
        : `${ref.workspaceId}:file:${ref.chatId}:${ref.fileId}`

/** The key a removed item is known by, as the server knows it (`libraryItemKey`). */
export const removalKey = (ref: LibraryItemRef) =>
  ref.kind === 'app' ? `${ref.workspaceId}:app:${ref.workpieceId}`
    : ref.kind === 'file' ? `${ref.workspaceId}:file:${ref.chatId}:${ref.fileId}`
      : `${ref.workspaceId}:external:${ref.subjectId}`

const latest = (a: LibraryEntry, b: LibraryEntry) => b.at.getTime() - a.at.getTime()

const entryKey = (workspaceId: string, item: AsideItem) => `${workspaceId}/${item.key}`

/** A file's name, or else what it is. */
export const fileTitle = ({ name, mimeType }: { name?: string; mimeType: string }) => name || `Untitled ${mimeType.split('/')[1] || 'file'}`

type Gadget = Pick<OutputSummary, 'workspaceId' | 'workpieceId' | 'title' | 'output'> & Partial<Pick<OutputSummary, 'workspaceTitle' | 'owner' | 'role' | 'waiting'>> & { at: Date }

const gadgetEntry = (gadget: Gadget, sources: LibrarySources, starred: ReadonlySet<string>): LibraryEntry => {
  const { workspaceId, workpieceId, output } = gadget
  const title = gadget.title || 'Untitled'
  const format = output && { noun: output.noun, icon: output.icon }
  const item: AsideItem = {
    key: formatAsideRef({ kind: 'output', workpieceId }),
    title,
    at: gadget.at,
    kind: 'output',
    output: { workspaceId, workpieceId, type: 'gadget', format },
  }
  const favorite: FavoriteItemSpec = { kind: 'app', workspaceId, workpieceId, title, ...(output && { output }) }
  return {
    key: entryKey(workspaceId, item),
    item,
    section: 'gadget',
    title,
    output,
    at: gadget.at,
    workspaceId,
    workspaceTitle: gadget.workspaceTitle || undefined,
    sharedBy: gadget.owner?.name,
    favorite,
    starred: starred.has(favoriteKey(favorite)),
    removal: { kind: 'app', workspaceId, workpieceId },
    waiting: waitingOn(gadget) || undefined,
    builds: sources.builds.has(workspaceId),
  }
}

const fileEntry = (file: WorkspaceFile, starred: ReadonlySet<string>): LibraryEntry => {
  const { workspaceId, chatId, id, mimeType, size } = file
  const title = fileTitle(file)
  const item: AsideItem = {
    key: formatAsideRef({ kind: 'file', fileId: id }),
    title,
    at: file.attached,
    kind: 'file',
    file: { id, name: title, mimeType, size, workspaceId, chatId },
  }
  const favorite: FavoriteItemSpec = { kind: 'file', workspaceId, chatId, fileId: id, title, mimeType }
  return {
    key: entryKey(workspaceId, item),
    item,
    section: 'file',
    title,
    at: file.attached,
    workspaceId,
    workspaceTitle: file.workspaceTitle,
    chatId,
    favorite,
    starred: starred.has(favoriteKey(favorite)),
    removal: { kind: 'file', workspaceId, chatId, fileId: id },
    builds: false,
  }
}

const connectedEntry = (file: LibrarySources['connected'][number], starred: ReadonlySet<string>): LibraryEntry => {
  const { workspaceId, gatekeeperId, subjectId, kind, url } = file
  const item: AsideItem = {
    key: formatAsideRef({ kind: 'connected', gatekeeperId, subjectId }),
    title: file.title,
    at: file.at,
    kind: 'connected',
    connected: { workspaceId, gatekeeperId, subjectId, fileKind: kind, url },
  }
  const favorite: FavoriteItemSpec = { kind: 'external', workspaceId, subjectId, title: file.title }
  return {
    key: entryKey(workspaceId, item),
    item,
    section: 'file',
    title: file.title,
    at: file.at,
    workspaceId,
    workspaceTitle: file.workspaceTitle,
    chatId: file.chatId,
    favorite,
    starred: starred.has(favoriteKey(favorite)),
    removal: { kind: 'external', workspaceId, subjectId },
    builds: false,
  }
}

/**
 * Whether an entry is still in the Library. One taken out stays out, except a connected file that
 * has been worked on since, which is in use again.
 */
const kept = (entry: LibraryEntry, removals: ReadonlyMap<string, Date>) => {
  const removed = removals.get(removalKey(entry.removal))
  return removed === undefined || (entry.removal.kind === 'external' && entry.at > removed)
}

/** The Library's entries, by what they are, and the starred ones, latest starred first. */
export type LibraryEntries = { gadgets: LibraryEntry[]; files: LibraryEntry[]; favorites: LibraryEntry[] }

/**
 * Everything in the Library, each once and latest first: the gadgets made in the viewer's
 * workspaces and those shared with them, the files sent in their chats, and the files of connected
 * services their agents worked on. A starred item the listings do not have (a file in a workspace
 * that was not read) is still a favorite, from what starring it recorded.
 */
export const libraryEntries = (sources: LibrarySources): LibraryEntries => {
  const starred = new Set(sources.favorites.map(favoriteKey))
  const gadgets = sources.outputs
    .map((output) => gadgetEntry({ ...output, at: output.lastActive }, sources, starred))
    .filter((entry) => kept(entry, sources.removals))
    .toSorted(latest)
  const files = [
    ...sources.files.map((file) => fileEntry(file, starred)),
    ...sources.connected.map((file) => connectedEntry(file, starred)),
  ].filter((entry) => kept(entry, sources.removals)).toSorted(latest)

  const listed = new Map([...gadgets, ...files].flatMap((entry) => (entry.favorite ? [[favoriteKey(entry.favorite), entry] as const] : [])))
  const favorites = sources.favorites.flatMap((favorite): LibraryEntry[] => {
    const found = listed.get(favoriteKey(favorite))
    if (found) return [found]
    // Starred chats are listed in their workspace, not in the Library; a connected file is opened
    // through the connection its workspace lists it with, so it is shown only while listed.
    if (favorite.kind === 'chat' || favorite.kind === 'external') return []
    const entry = favorite.kind === 'app'
      ? gadgetEntry({ ...favorite, at: favorite.starred }, sources, starred)
      : fileEntry({ ...favorite, id: favorite.fileId, name: favorite.title, mimeType: favorite.mimeType ?? 'application/octet-stream', size: 0, attached: favorite.starred }, starred)
    return kept(entry, sources.removals) ? [entry] : []
  })
  return { gadgets, files, favorites }
}

/** One group of a Library list, as `GroupedList` draws it. */
export type LibraryGroup = {
  key: string
  /** What its rows have in common: "Starred", "Today", "A to Z". */
  label: string
  /** Each with when it was, as the list puts it. */
  rows: Array<{ entry: LibraryEntry; time?: string }>
}

/** A row of a Library list, with when it was: as its order says, else when it was last worked on. */
export const libraryRow = (entry: LibraryEntry, time?: string, now: Date = new Date()) => ({ entry, time: time ?? formatActivity(entry.at, now) })

/**
 * A Library list in groups. What waits on the viewer to approve leads, out of the groups it would
 * be in otherwise, so that it is seen first; but not for a list of files (`waiting: false`), which
 * have nothing to approve. Then the starred, those of `shown` unless they are given (`starred`, as
 * Recent has some that are not listed), in the order the user put them in (`starOrder`, see
 * `byStarOrder`). Then the rest, as the list's order groups them (`arrange`, its groups' keys
 * under the order's `orderId`).
 */
export const libraryGroups = (
  shown: LibraryEntry[],
  { starred, starOrder, waiting: leads = true, arrange, orderId, now = new Date() }: {
    starred?: LibraryEntry[]
    starOrder: string[]
    waiting?: boolean
    arrange: (rest: LibraryEntry[]) => ArrangedGroup<LibraryEntry>[]
    orderId: string
    now?: Date
  },
): LibraryGroup[] => {
  const waiting = leads ? shown.filter((entry) => entry.waiting) : []
  const waits = new Set(waiting.map(({ key }) => key))
  const stars = byStarOrder((starred ?? shown.filter((entry) => entry.starred)).filter(({ key }) => !waits.has(key)), starOrder)
  const rest = shown.filter((entry) => !entry.starred && !waits.has(entry.key))
  const row = (entry: LibraryEntry) => libraryRow(entry, undefined, now)
  return [
    ...(waiting.length > 0 ? [{ key: 'waiting', label: 'Needs approval', rows: waiting.toSorted(latest).map(row) }] : []),
    ...(stars.length > 0 ? [{ key: 'starred', label: 'Starred', rows: stars.map(row) }] : []),
    ...arrange(rest).map(({ key, label, entries }) => ({ key: `${orderId}:${key}`, label, rows: entries.map(({ value, time }) => libraryRow(value, time, now)) })),
  ]
}
