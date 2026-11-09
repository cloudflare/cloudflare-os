import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { BlueprintOutput, FavoriteItem, FavoriteItemSpec } from '@gadgets/workshop-shared/api'
import type { LibraryItem } from './LibraryViews'
import type { PreviewFile } from './FilePreviewPane'
import type { LibraryPreview } from './LibraryPreviewPane'
import { favoriteRefKey, useFileLoader } from './useLibraryData'
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
 * screen, previewing a file in the page's pane, starring, and the More menu's links. Files in
 * connected services are listed among the files, but not starred: they live with their provider.
 */
export function useLibraryItems({ apps, files, external = NO_EXTERNAL, favorites, starred, showContext }: {
  apps: LibraryAppSource[]
  files: LibraryFileSource[]
  external?: ExternalFileSource[]
  favorites: FavoriteItem[]
  starred: ReadonlySet<string>
  /** Name each item's workspace beside it, as the all-workspaces Library does. */
  showContext: boolean
}) {
  const navigate = useNavigate()
  const loadFile = useFileLoader()
  const [preview, setPreview] = useState<LibraryPreview | null>(null)

  // An app opens live beside the list, as a file does; on its own is a step further.
  const previewApp = (app: LibraryAppSource) => setPreview({ kind: 'app', app: {
    workspaceId: app.workspaceId, workpieceId: app.workpieceId, title: app.title, output: app.output,
  } })
  const openApp = (workspaceId: string, workpieceId: number) => navigate({
    to: '/workspace/$id/app/$appId', params: { id: workspaceId, appId: String(workpieceId) },
  })
  const openChat = (workspaceId: string, chatId: number) => navigate({
    to: '/workspace/$id', params: { id: workspaceId }, search: { chat: chatId },
  })

  const appItem = (app: LibraryAppSource): LibraryItem => {
    const favorite: FavoriteItemSpec = {
      kind: 'app', workspaceId: app.workspaceId, workpieceId: app.workpieceId, title: app.title,
      ...(app.output ? { output: app.output } : {}),
    }
    return {
      key: favoriteRefKey(favorite), kind: 'app', title: app.title, date: app.date,
      starred: starred.has(favoriteRefKey(favorite)), favorite, output: app.output,
      context: showContext ? app.workspaceTitle : undefined,
      onOpen: () => previewApp(app),
      actions: [
        { label: 'Open', onSelect: () => previewApp(app) },
        { label: 'Open on its own', onSelect: () => openApp(app.workspaceId, app.workpieceId) },
        { label: 'Open with chat', onSelect: () => navigate({ to: '/workspace/$id', params: { id: app.workspaceId }, search: { w: app.workpieceId } }) },
        { label: 'App settings', onSelect: () => navigate({
          to: '/workspace/$id/app/$appId/settings',
          params: { id: app.workspaceId, appId: String(app.workpieceId) },
        }) },
      ],
    }
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
    return {
      key: favoriteRefKey(favorite), kind: 'file', title, date: file.attached,
      starred: starred.has(favoriteRefKey(favorite)), favorite, mimeType: file.mimeType, loadContent,
      context: showContext ? file.workspaceTitle : undefined,
      onOpen: () => setPreview({ kind: 'file', file: previewFile }),
      actions: [
        { label: 'Preview', onSelect: () => setPreview({ kind: 'file', file: previewFile }) },
        { label: 'Download', onSelect: () => void loadContent().then(bytes => saveBytesToFile(bytes, title, file.mimeType)) },
        { label: 'Open chat', onSelect: () => openChat(file.workspaceId, file.chatId) },
      ],
    }
  }

  const externalItem = (file: ExternalFileSource): LibraryItem => {
    const open = () => setPreview({ kind: 'external', file })
    return {
      key: `external:${file.workspaceId}:${file.subjectId}`, kind: 'file', title: file.title, date: file.date,
      starred: false, mimeType: file.mediaType,
      context: showContext ? file.workspaceTitle : undefined,
      onOpen: open,
      actions: [
        { label: 'Preview', onSelect: open },
        { label: OPEN_LABEL[file.kind], onSelect: () => window.open(file.url, '_blank', 'noopener') },
      ],
    }
  }

  const appItems = useMemo(() => apps.map(appItem), [apps, starred, showContext])
  const fileItems = useMemo(() => [...files.map(fileItem), ...external.map(externalItem)],
    [files, external, starred, showContext])

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
          attached: favorite.starred }))])
  }, [favorites, appItems, fileItems])

  return { appItems, fileItems, favoriteItems, preview, setPreview }
}
