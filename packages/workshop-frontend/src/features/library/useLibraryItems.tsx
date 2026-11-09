import { useMemo, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import type { AppPageOrigin } from '../gadget-page/appPageOrigin'
import type { BlueprintOutput, FavoriteItem, FavoriteItemSpec } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { logRpcFailure } from '../../rpcErrors'
import type { LibraryItem } from './LibraryViews'
import type { PreviewFile } from './FilePreviewPane'
import type { LibraryPreview } from './LibraryPreviewPane'
import { favoriteRefKey, libraryRefKey, useFileLoader, useLibraryRemovals } from './useLibraryData'
import { saveBytesToFile } from './saveBytes'
import type { ExternalFileSource } from './externalFiles'
import { OPEN_LABEL } from '../drafts/drafts'

/** An app as the Library's builders take it. */
export type LibraryAppSource = {
  workspaceId: string
  workpieceId: number
  title: string
  output?: BlueprintOutput
  date: Date
  workspaceTitle?: string
  /** The user builds in its workspace, so may delete it. */
  canDelete?: boolean
}

/** A file as the Library's builders take it. */
export type LibraryFileSource = {
  workspaceId: string
  chatId: number
  id: string
  name?: string
  mimeType: string
  attached: Date
  workspaceTitle?: string
}

/** A file's display name: its upload name, else its type. */
export const fileTitle = (file: { name?: string; mimeType: string }) =>
  file.name ?? `Untitled ${file.mimeType.split('/')[1] ?? 'file'}`

const NO_EXTERNAL: ExternalFileSource[] = []

/**
 * Turns apps, files and favorites into Library items with their actions: opening an app full
 * screen, previewing a file in the page's pane, starring, taking it out of the Library, deleting
 * an app, and the More menu's links. Files in connected services are listed among the files, but
 * not starred or deleted: they live with their provider. Render `dialogs` for the confirmations.
 */
export function useLibraryItems({ apps, files, external = NO_EXTERNAL, favorites, starred, setStarred, showContext, origin }: {
  apps: LibraryAppSource[]
  files: LibraryFileSource[]
  external?: ExternalFileSource[]
  favorites: FavoriteItem[]
  starred: ReadonlySet<string>
  /** Unstars what is taken out of the Library. */
  setStarred?: (item: FavoriteItemSpec, star: boolean) => unknown
  /** Name each item's workspace beside it, as the all-workspaces Library does. */
  showContext: boolean
  /** The page listing the items, which a gadget opened on its own returns to. */
  origin: AppPageOrigin
}) {
  const navigate = useNavigate()
  const loadFile = useFileLoader()
  const [preview, setPreview] = useState<LibraryPreview | null>(null)
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { removals, setRemoved } = useLibraryRemovals()
  const [deleting, setDeleting] = useState<{ app: LibraryAppSource; busy: boolean } | null>(null)
  // Apps deleted here, gone at once rather than when the listing next refreshes.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set())
  // The item whose name is being edited in place, and names given here, shown at once rather than
  // when the listing next refreshes (by item key).
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamed, setRenamed] = useState<ReadonlyMap<string, string>>(new Map())

  /** Takes items out of the Library, unstarring them; the items themselves stay as they are. */
  const remove = (items: readonly LibraryItem[]) => {
    const refs = items.flatMap(item => item.libraryRef ? [item.libraryRef] : [])
    if (refs.length === 0) return
    for (const item of items) if (item.libraryRef && item.starred && item.favorite) setStarred?.(item.favorite, false)
    void setRemoved(refs, true)
    setPreview(null)
    toasts.add({ title: refs.length === 1 ? `Removed “${items.find(item => item.libraryRef)!.title}” from your Library`
      : `Removed ${refs.length} items from your Library` })
  }
  const removeAction = (item: () => LibraryItem) => ({ label: 'Remove from Library', onSelect: () => remove([item()]) })

  const deleteApp = async (app: LibraryAppSource) => {
    setDeleting({ app, busy: true })
    const overseer = authenticatedApi.openWorkspace(app.workspaceId)
    const gadget = overseer.getGadget(app.workpieceId)
    try {
      await gadget.remove()
      setDeleted(current => new Set(current).add(libraryRefKey({ kind: 'app', ...app })))
      const key = favoriteRefKey({ kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId })
      if (starred.has(key)) setStarred?.({ kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId, title: app.title }, false)
      setPreview(current => current?.kind === 'app' && current.app.workspaceId === app.workspaceId
        && current.app.workpieceId === app.workpieceId ? null : current)
      setDeleting(null)
      toasts.add({ title: `Deleted “${app.title}”` })
    } catch (err) {
      logRpcFailure('Failed to delete app:', err)
      setDeleting({ app, busy: false })
      toasts.add({ title: "Couldn't delete the gadget", variant: 'error' })
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  // An app opens live beside the list, as a file does; on its own is a step further.
  const previewApp = (app: Pick<LibraryAppSource, 'workspaceId' | 'workpieceId' | 'title' | 'output'>) => {
    const favorite = { kind: 'app' as const, workspaceId: app.workspaceId, workpieceId: app.workpieceId, output: app.output }
    const key = favoriteRefKey(favorite)
    setPreview({ kind: 'app', app: {
      workspaceId: app.workspaceId, workpieceId: app.workpieceId, output: app.output, from: origin,
      title: renamed.get(key) ?? app.title,
      // Renamed from the pane, which made the change itself.
      onRenamed: title => noteRenamed(key, { ...favorite, title }),
    } })
  }
  const openApp = (workspaceId: string, workpieceId: number) => navigate({
    to: '/workspace/$id/app/$appId', params: { id: workspaceId, appId: String(workpieceId) }, search: { from: origin },
  })
  const openChat = (workspaceId: string, chatId: number) => navigate({
    to: '/workspace/$id', params: { id: workspaceId }, search: { chat: chatId },
  })

  // Shows a gadget's new name here at once. A starred one is starred again, which refreshes the
  // name its favorite recorded.
  const noteRenamed = (key: string, favorite: FavoriteItemSpec & { kind: 'app' }) => {
    setRenamed(current => new Map(current).set(key, favorite.title))
    if (starred.has(key)) setStarred?.(favorite, true)
  }

  // Renames a gadget for everyone it is shared with, as renaming it in its workspace does.
  const renameApp = async (key: string, favorite: FavoriteItemSpec & { kind: 'app' }, title: string) => {
    const previous = renamed.get(key)
    setRenamed(current => new Map(current).set(key, title))
    const overseer = authenticatedApi.openWorkspace(favorite.workspaceId)
    const gadget = overseer.getGadget(favorite.workpieceId)
    try {
      await gadget.setTitle(title)
      noteRenamed(key, { ...favorite, title })
      setPreview(current => current?.kind === 'app' && current.app.workspaceId === favorite.workspaceId
        && current.app.workpieceId === favorite.workpieceId ? { ...current, app: { ...current.app, title } } : current)
    } catch (err) {
      logRpcFailure('Failed to rename gadget:', err)
      setRenamed(current => {
        const next = new Map(current)
        if (previous === undefined) next.delete(key)
        else next.set(key, previous)
        return next
      })
      toasts.add({ title: "Couldn't rename the gadget", variant: 'error' })
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  const appItem = (app: LibraryAppSource): LibraryItem => {
    const key = favoriteRefKey({ kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId })
    const title = renamed.get(key) ?? app.title
    const favorite: FavoriteItemSpec & { kind: 'app' } = {
      kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId, title,
      ...(app.output ? { output: app.output } : {}),
    }
    const isStarred = starred.has(key)
    const item: LibraryItem = {
      key, kind: 'app', title, date: app.date,
      starred: isStarred, favorite, output: app.output,
      libraryRef: { kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId },
      renaming: renaming === key ? { finish: next => {
        setRenaming(null)
        if (next !== null) void renameApp(key, favorite, next)
      } } : undefined,
      context: showContext ? app.workspaceTitle : undefined,
      onOpen: () => previewApp(app),
      actions: [
        { label: 'Open', onSelect: () => previewApp(app) },
        { label: 'Open on its own', onSelect: () => openApp(app.workspaceId, app.workpieceId) },
        { label: 'Open with chat', onSelect: () => navigate({ to: '/workspace/$id', params: { id: app.workspaceId }, search: { w: app.workpieceId } }) },
        ...(app.canDelete ? [{ label: 'Rename', onSelect: () => setRenaming(key) }] : []),
        { label: 'Gadget settings', onSelect: () => navigate({
          to: '/workspace/$id/app/$appId/settings',
          params: { id: app.workspaceId, appId: String(app.workpieceId) }, search: { from: origin },
        }) },
        'separator',
        removeAction(() => item),
        ...(app.canDelete ? [{ label: 'Delete gadget…', danger: true, onSelect: () => setDeleting({ app, busy: false }) }] : []),
      ],
    }
    return item
  }

  const fileItem = (file: LibraryFileSource): LibraryItem => {
    const title = fileTitle(file)
    const favorite: FavoriteItemSpec = {
      kind: 'file', workspaceId: file.workspaceId, chatId: file.chatId, fileId: file.id, title,
      mimeType: file.mimeType,
    }
    const loadContent = loadFile(file.workspaceId, file.chatId, file.id)
    const previewFile: PreviewFile = {
      title, mimeType: file.mimeType, loadContent,
      onOpenChat: () => openChat(file.workspaceId, file.chatId),
    }
    const item: LibraryItem = {
      key: favoriteRefKey(favorite), kind: 'file', title, date: file.attached,
      starred: starred.has(favoriteRefKey(favorite)), favorite, mimeType: file.mimeType, loadContent,
      libraryRef: { kind: 'file', workspaceId: file.workspaceId, chatId: file.chatId, fileId: file.id },
      context: showContext ? file.workspaceTitle : undefined,
      onOpen: () => setPreview({ kind: 'file', file: previewFile }),
      actions: [
        { label: 'Preview', onSelect: () => setPreview({ kind: 'file', file: previewFile }) },
        { label: 'Download', onSelect: () => void loadContent().then(bytes => saveBytesToFile(bytes, title, file.mimeType)) },
        { label: 'Open chat', onSelect: () => openChat(file.workspaceId, file.chatId) },
        'separator',
        removeAction(() => item),
      ],
    }
    return item
  }

  const externalItem = (file: ExternalFileSource): LibraryItem => {
    const open = () => setPreview({ kind: 'external', file })
    const item: LibraryItem = {
      key: `external:${file.workspaceId}:${file.subjectId}`, kind: 'file', title: file.title, date: file.date,
      starred: false, mimeType: file.mediaType,
      libraryRef: { kind: 'external', workspaceId: file.workspaceId, subjectId: file.subjectId },
      context: showContext ? file.workspaceTitle : undefined,
      onOpen: open,
      actions: [
        { label: 'Preview', onSelect: open },
        { label: OPEN_LABEL[file.kind], onSelect: () => window.open(file.url, '_blank', 'noopener') },
        'separator',
        removeAction(() => item),
      ],
    }
    return item
  }

  // Taken out, an item stays out -- except a connected file that has been worked on since, which
  // is back in use.
  const shown = (item: LibraryItem) => {
    if (!item.libraryRef) return true
    const key = libraryRefKey(item.libraryRef)
    if (deleted.has(key)) return false
    const removed = removals.get(key)
    return !removed || (item.libraryRef.kind === 'external' && item.date > removed)
  }

  const appItems = useMemo(() => apps.map(appItem).filter(shown),
    [apps, starred, showContext, removals, deleted, renaming, renamed])
  const fileItems = useMemo(() => [...files.map(fileItem), ...external.map(externalItem)].filter(shown),
    [files, external, starred, showContext, removals, deleted])

  // A starred item no longer in the listings (a file in a workspace the Library didn't read, say)
  // is still shown from what starring recorded.
  const favoriteItems = useMemo(() => {
    const known = new Map([...appItems, ...fileItems].map(item => [item.key, item]))
    // Starred chats are listed in their workspace, not in the Library.
    return favorites.flatMap(favorite => favorite.kind === 'chat' ? [] : [known.get(favoriteRefKey(favorite)) ?? (favorite.kind === 'app'
      ? appItem({ workspaceId: favorite.workspaceId, workpieceId: favorite.workpieceId,
          title: favorite.title, output: favorite.output, date: favorite.starred })
      : fileItem({ workspaceId: favorite.workspaceId, chatId: favorite.chatId, id: favorite.fileId,
          name: favorite.title, mimeType: favorite.mimeType ?? 'application/octet-stream',
          attached: favorite.starred }))]).filter(shown)
  }, [favorites, appItems, fileItems, removals, deleted, renaming, renamed])

  const dialogs = (
    <DeleteConfirmationDialog
      open={deleting !== null}
      title="Delete gadget?"
      description={<>This deletes <span className="font-medium text-kumo-default">{deleting?.app.title}</span> for everyone it is shared with. You can&apos;t undo this.</>}
      isDeleting={deleting?.busy === true}
      onOpenChange={open => { if (!open) setDeleting(null) }}
      onConfirm={() => { if (deleting) void deleteApp(deleting.app) }}
    />
  )

  return { appItems, fileItems, favoriteItems, preview, setPreview, previewApp, remove, dialogs }
}
