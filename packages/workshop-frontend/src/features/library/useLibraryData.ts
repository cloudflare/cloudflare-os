import { useCallback, useEffect, useMemo, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type {
  ChatFileSummary,
  FavoriteItem,
  FavoriteItemRef,
  FavoriteItemSpec,
  OutputSummary,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

/** The key a starred item is known by, matching the server's (see `favoriteKey`). */
export const favoriteRefKey = (item: FavoriteItemRef) => item.kind === 'app'
  ? `${item.workspaceId}:app:${item.workpieceId}`
  : item.kind === 'chat' ? `${item.workspaceId}:chat:${item.chatId}`
  : `${item.workspaceId}:file:${item.chatId}:${item.fileId}`

/** The user's starred apps and files, and a way to star or unstar one that updates at once. */
export function useFavorites() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [favorites, setFavorites] = useState<FavoriteItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listFavorites().then(
      list => { if (!cancelled) setFavorites(list) },
      err => { logRpcFailure('Failed to list favorites:', err); if (!cancelled) setFavorites([]) })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const starred = useMemo(() => new Set((favorites ?? []).map(favoriteRefKey)), [favorites])

  const setStarred = useCallback(async (item: FavoriteItemSpec, star: boolean) => {
    const key = favoriteRefKey(item)
    const previous = favorites
    setFavorites(list => {
      const rest = (list ?? []).filter(entry => favoriteRefKey(entry) !== key)
      return star ? [{ ...item, starred: new Date() }, ...rest] : rest
    })
    try {
      await authenticatedApi.setFavorite(item, star)
    } catch (err) {
      logRpcFailure('Failed to update favorite:', err)
      setFavorites(previous)
      toasts.add({ title: star ? "Couldn't star this" : "Couldn't unstar this", variant: 'error' })
    }
  }, [authenticatedApi, favorites, toasts])

  return { favorites, starred, setStarred }
}

/** The apps of every workspace the user can see, from their outputs index. */
export function useOutputs() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [outputs, setOutputs] = useState<OutputSummary[] | null>(null)
  const refresh = useCallback(() => {
    authenticatedApi.listOutputs().then(
      ({ outputs }) => setOutputs(outputs),
      err => { logRpcFailure('Failed to list apps:', err); setOutputs(current => current ?? []) })
  }, [authenticatedApi])
  useEffect(refresh, [refresh])
  return { outputs, setOutputs, refresh }
}

/** A chat file together with the workspace it lives in. */
export type WorkspaceFile = ChatFileSummary & { workspaceId: string; workspaceTitle: string }

// The global Library reads files workspace by workspace; it looks in this many, most recent first.
const FILE_WORKSPACE_LIMIT = 40

/**
 * The files attached in the chats of the given workspaces. Each workspace is asked in parallel, in
 * one pipelined call, and released as soon as it answers.
 */
export function useWorkspaceFiles(workspaces: { id: string; title: string }[] | null) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null)
  const ids = workspaces?.slice(0, FILE_WORKSPACE_LIMIT).map(w => `${w.id}\u0000${w.title}`).join('\u0001')
  useEffect(() => {
    if (ids === undefined) return
    let cancelled = false
    const targets = ids === '' ? [] : ids.split('\u0001').map(entry => {
      const [id, title] = entry.split('\u0000')
      return { id, title }
    })
    Promise.all(targets.map(async ({ id, title }) => {
      const overseer = authenticatedApi.openWorkspace(id)
      try {
        const list = await overseer.listChatFiles()
        return list.map(file => ({ ...file, workspaceId: id, workspaceTitle: title }))
      } catch (err) {
        logRpcFailure('Failed to list a workspace\'s files:', err)
        return []
      } finally {
        overseer[Symbol.dispose]()
      }
    })).then(lists => { if (!cancelled) setFiles(lists.flat()) })
    return () => { cancelled = true }
  }, [authenticatedApi, ids])
  return files
}

/** Fetches one chat file's bytes, opening its workspace for the call and releasing it after. */
export function useFileLoader() {
  const { authenticatedApi } = useAuthenticatedApi()
  return useCallback((workspaceId: string, chatId: number, fileId: string) => async () => {
    const overseer = authenticatedApi.openWorkspace(workspaceId)
    try {
      return await overseer.getChatAttachmentContent(chatId, fileId)
    } finally {
      overseer[Symbol.dispose]()
    }
  }, [authenticatedApi])
}
