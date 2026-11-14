import { useEffect, useMemo, useState } from 'react'
import type { ActionLogEntry, FavoriteItem, LibraryItemRef, Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { connectedFiles, type ConnectedFile } from './connectedFiles'
import { libraryEntries, favoriteKey, removalKey, type LibraryEntries, type LibraryEntry, type WorkspaceFile } from './libraryEntries'
import { useLibrary } from './useLibrary'

// Files are read workspace by workspace, from this many of the latest.
const WORKSPACES_READ = 40
// And this many pages of each one's action log, latest first, for the connected files it worked on.
const ACTION_PAGES_READ = 4

type Workspace = { id: string; title?: string; builds: boolean }

const readActions = async (overseer: RpcStub<Overseer>) => {
  const entries: ActionLogEntry[] = []
  let beforeId: number | undefined
  for (let page = 0; page < ACTION_PAGES_READ; page++) {
    const { entries: more, nextBeforeId } = await overseer.listActions(beforeId === undefined ? {} : { beforeId })
    entries.push(...more)
    beforeId = nextBeforeId
    if (beforeId === undefined) break
  }
  return entries
}

type WorkspaceFiles = { files: WorkspaceFile[]; connected: Array<ConnectedFile & { workspaceTitle?: string }> }

/**
 * What one workspace was sent and worked on. Only someone who builds in it can read its action log,
 * so only they see its connected files. A workspace that cannot be read has nothing in it here,
 * rather than keeping the rest from showing.
 */
const readWorkspace = async (api: ReturnType<typeof useApi>['api'], { id, title, builds }: Workspace): Promise<WorkspaceFiles> => {
  const overseer = api.openWorkspace(id)
  try {
    const [files, actions] = await Promise.all([
      overseer.listChatFiles().catch(() => []),
      builds ? readActions(overseer).catch(() => []) : [],
    ])
    return {
      files: files.map((file) => ({ ...file, workspaceId: id, workspaceTitle: title })),
      connected: connectedFiles(actions, id).map((file) => ({ ...file, workspaceTitle: title })),
    }
  } finally {
    overseer[Symbol.dispose]()
  }
}

export type LibraryEntriesState = {
  entries: LibraryEntries
  /** Nothing has arrived yet. */
  loading: boolean
  /** Why what was made could not be read, which would leave most of the Library out. */
  problem: string | undefined
  retry: (() => void) | undefined
  /** Stars or unstars an entry, shown at once and undone if the server refuses. */
  setStarred: (entry: LibraryEntry, starred: boolean) => Promise<void>
  /** Takes an entry out of the Library, at once, and puts it back if the server refuses. */
  remove: (entry: LibraryEntry) => Promise<void>
  /** Deletes a gadget from its workspace for everyone, gone from the list once it is. */
  deleteGadget: (entry: LibraryEntry) => Promise<void>
}

/**
 * The Library: what the user's workspaces, and those shared with them, made (`useLibrary`), the
 * files sent in their chats and the connected files they worked on, read from the latest workspaces
 * (`WORKSPACES_READ`), with what the user starred and took out. With `workspaceId`, only that
 * workspace's. Each source shows as it arrives; one that fails leaves only itself out.
 */
export const useLibraryEntries = (workspaceId?: string): LibraryEntriesState => {
  const { api, reconnecting } = useApi()
  const library = useLibrary(workspaceId)
  const workspaces = useWorkspaces()
  const [favorites, setFavorites] = useState<FavoriteItem[]>()
  const [removals, setRemovals] = useState<ReadonlyMap<string, Date>>(new Map())
  const [read, setRead] = useState<WorkspaceFiles>()
  // Deleted here, until the library is next read.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (reconnecting) return
    let cancelled = false
    api.listFavorites().then((items) => !cancelled && setFavorites(items), () => !cancelled && setFavorites([]))
    api.listLibraryRemovals().then(
      (items) => !cancelled && setRemovals(new Map(items.map((item) => [removalKey(item), item.removed]))),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  const known = workspaces.status === 'ready' ? workspaces.workspaces : undefined
  const targets = useMemo(() => {
    if (!known) return undefined
    const chosen = workspaceId === undefined ? known.slice(0, WORKSPACES_READ) : known.filter(({ id }) => id === workspaceId)
    return chosen.map((workspace): Workspace => ({ id: workspace.id, title: workspace.title || undefined, builds: workspace.role !== 'use' }))
  }, [known, workspaceId])
  // `targetsKey` stands for `targets` below: read again only when which workspaces to read changes, not each time the list is loaded.
  const targetsKey = targets?.map(({ id, builds }) => `${id}:${builds}`).join(' ')

  useEffect(() => {
    if (!targets || reconnecting) return
    let cancelled = false
    void Promise.all(targets.map((workspace) => readWorkspace(api, workspace).catch((): WorkspaceFiles => ({ files: [], connected: [] })))).then((each) => {
      if (!cancelled) setRead({ files: each.flatMap(({ files }) => files), connected: each.flatMap(({ connected }) => connected) })
    })
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, targetsKey])

  const outputs = library.status === 'ready' ? library.outputs : undefined
  const builds = useMemo(() => new Set(targets?.filter((workspace) => workspace.builds).map(({ id }) => id)), [targets])
  const entries = useMemo(() => {
    const all = libraryEntries({
      outputs: (outputs ?? []).filter((output) => workspaceId === undefined || output.workspaceId === workspaceId),
      files: read?.files ?? [],
      connected: read?.connected ?? [],
      favorites: (favorites ?? []).filter((favorite) => workspaceId === undefined || favorite.workspaceId === workspaceId),
      removals,
      builds,
    })
    const left = (list: LibraryEntry[]) => list.filter((entry) => !deleted.has(entry.key))
    return { gadgets: left(all.gadgets), files: left(all.files), favorites: left(all.favorites) }
  }, [outputs, read, favorites, removals, builds, deleted, workspaceId])

  const setStarred = async (entry: LibraryEntry, starred: boolean) => {
    const { favorite } = entry
    if (!favorite) return
    const key = favoriteKey(favorite)
    const without = (items: FavoriteItem[] = []) => items.filter((item) => favoriteKey(item) !== key)
    setFavorites((items) => (starred ? [{ ...favorite, starred: new Date() }, ...without(items)] : without(items)))
    try {
      await api.setFavorite(favorite, starred)
    } catch (error) {
      setFavorites((items) => (starred ? without(items) : [{ ...favorite, starred: entry.at }, ...without(items)]))
      throw error
    }
  }

  const setRemoved = (ref: LibraryItemRef, at: Date | undefined) =>
    setRemovals((current) => {
      const next = new Map(current)
      if (at) next.set(removalKey(ref), at)
      else next.delete(removalKey(ref))
      return next
    })

  const remove = async (entry: LibraryEntry) => {
    setRemoved(entry.removal, new Date())
    try {
      await api.setLibraryRemoved(entry.removal, true)
    } catch (error) {
      setRemoved(entry.removal, undefined)
      throw error
    }
  }

  const deleteGadget = async (entry: LibraryEntry) => {
    if (entry.item.kind !== 'output') return
    const overseer = api.openWorkspace(entry.workspaceId)
    const gadget = overseer.getGadget(entry.item.output.workpieceId)
    try {
      await gadget.remove()
      setDeleted((current) => new Set([...current, entry.key]))
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  return {
    entries,
    loading: outputs === undefined && library.status !== 'failed',
    problem: library.status === 'failed' ? library.message : undefined,
    retry: library.status === 'failed' ? library.retry : undefined,
    setStarred,
    remove,
    deleteGadget,
  }
}
