import { useEffect, useState } from 'react'
import { useObjectUrl } from '@/hooks/useObjectUrl'
import { useApi } from '@/rpc/ApiContext'
import type { LibraryEntry } from './libraryEntries'

// Pictures the browser draws as they are, and nothing that could run: never an SVG.
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
// A larger one is shown by its glyph, rather than fetched whole to be drawn small.
const LARGEST = 4 * 1024 * 1024
// What was fetched is kept for this many, so that switching between the list and the grid, or tabs,
// does not fetch them again.
const KEPT = 80

const fetched = new Map<string, Promise<Uint8Array>>()

const remember = (key: string, bytes: Promise<Uint8Array>) => {
  fetched.set(key, bytes)
  if (fetched.size > KEPT) fetched.delete(fetched.keys().next().value!)
  // One that failed is asked for again next time.
  bytes.catch(() => fetched.delete(key))
  return bytes
}

/**
 * A picture of an entry to show small in its place: an image file's own, when it is one the
 * browser draws and not too large to fetch for that. Nothing for anything else, or until it arrives.
 */
export const useThumbnail = (entry: LibraryEntry): string | undefined => {
  const { api, reconnecting } = useApi()
  const file = entry.item.kind === 'file' ? entry.item.file : undefined
  const wanted = file && file.chatId !== undefined && PICTURES.has(file.mimeType) && file.size > 0 && file.size <= LARGEST ? file : undefined
  const key = wanted && `${wanted.workspaceId}/${wanted.chatId}/${wanted.id}`
  const workspaceId = wanted?.workspaceId
  const chatId = wanted?.chatId
  const fileId = wanted?.id
  const [bytes, setBytes] = useState<{ key: string; bytes: Uint8Array }>()

  useEffect(() => {
    if (!key || reconnecting || workspaceId === undefined || chatId === undefined || fileId === undefined) return
    let cancelled = false
    const known = fetched.get(key)
    const loading = known ?? remember(key, (async () => {
      const overseer = api.openWorkspace(workspaceId)
      try {
        return await overseer.getChatAttachmentContent(chatId, fileId)
      } finally {
        overseer[Symbol.dispose]()
      }
    })())
    loading.then((got) => !cancelled && setBytes({ key, bytes: got }), () => {})
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, key, workspaceId, chatId, fileId])

  return useObjectUrl(bytes && bytes.key === key ? bytes.bytes : undefined, wanted?.mimeType ?? '')
}
