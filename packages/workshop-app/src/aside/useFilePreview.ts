import { useEffect, useMemo, useState } from 'react'
import type { ChatAttachmentInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import type { AsideFile } from './asideItems'
import { saveBytes } from '@/files/saveBytes'
import { SVG_TYPE, svgDataUrl } from '@/files/svgImage'
import { isDrawnKind, previewOf, type DrawnKind, type FilePreview } from './filePreview'

/** How a file is shown, with an address for its bytes where the browser shows them. */
export type ShownFile =
  | { kind: 'image' | 'audio' | 'video'; url: string }
  /** Drawn by the app from the file's bytes. */
  | { kind: DrawnKind; bytes: Uint8Array; mimeType: string }
  | Exclude<FilePreview, { type: string } | { kind: DrawnKind }>

export type FileState =
  | { status: 'loading' }
  /** Its bytes cannot be reached: there is no chat to fetch them through. */
  | { status: 'unreachable' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      /** What it is, as its workspace has it, which a file named by a link alone is not until now. */
      file: { name: string; mimeType: string; size: number }
      preview: ShownFile
      /** Saves it to this device, as it was sent. */
      download: () => void
    }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A file sent in a chat, ready to show: the bytes it came with, or else fetched through the chat,
 * and how to show them (`previewOf`). Nothing, for no file. Showing another starts over. One named
 * by a link alone (no type: see `asideItemFor`) has its name and type read with its bytes
 * (`getChatAttachment`).
 */
export const useFilePreview = (file: AsideFile | undefined): FileState => {
  const { api, reconnecting } = useApi()
  const key = file && `${file.workspaceId}/${file.chatId}/${file.id}`
  // What was fetched, for the file it was fetched for.
  const [fetched, setFetched] = useState<{ key: string; bytes?: Uint8Array; info?: ChatAttachmentInfo; error?: string }>()
  const inline = file?.content
  const workspaceId = file?.workspaceId
  const chatId = file?.chatId
  const fileId = file?.id
  const linkedAlone = file?.mimeType === ''

  useEffect(() => {
    if (!key || inline || workspaceId === undefined || chatId === undefined || fileId === undefined) return
    // Over a lost connection it could only fail; the new connection's `api` fetches it.
    if (reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([overseer.getChatAttachmentContent(chatId, fileId), linkedAlone ? overseer.getChatAttachment(chatId, fileId) : undefined]).then(
      ([bytes, info]) => {
        if (!cancelled) setFetched({ key, bytes, info })
      },
      (error: unknown) => {
        if (!cancelled) setFetched({ key, error: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, key, inline, workspaceId, chatId, fileId, linkedAlone])

  const current = fetched?.key === key ? fetched : undefined
  const bytes = inline ?? current?.bytes
  const info = current?.info
  const name = info?.name ?? file?.name ?? 'File'
  const mimeType = info?.mimeType ?? file?.mimeType ?? ''
  const size = info?.size ?? file?.size ?? 0
  const preview = useMemo(() => bytes && previewOf({ name, mimeType }, bytes), [bytes, name, mimeType])

  // An address for the bytes, for as long as they are shown. An object URL is of the app's own
  // origin, and can be opened in a tab of its own, so its type is only ever one `previewOf` chose,
  // which runs nothing: never a page. An SVG, which is one, is given from a `data:` URL instead,
  // which has no origin.
  const [address, setAddress] = useState<{ bytes: Uint8Array; url: string }>()
  const type = preview && 'type' in preview ? preview.type : undefined
  useEffect(() => {
    if (!bytes || !type) return
    if (type === SVG_TYPE) {
      setAddress({ bytes, url: svgDataUrl(bytes) })
      return
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    setAddress({ bytes, url })
    return () => URL.revokeObjectURL(url)
  }, [bytes, type])

  if (!file) return { status: 'loading' }
  if (!bytes) {
    if (current?.error !== undefined) return { status: 'failed', message: current.error }
    return chatId === undefined && !inline ? { status: 'unreachable' } : { status: 'loading' }
  }
  if (!preview) return { status: 'loading' }
  const download = () => saveBytes(bytes, name)
  const shown = { name, mimeType, size }
  if (isDrawnKind(preview.kind)) return { status: 'ready', file: shown, preview: { kind: preview.kind, bytes, mimeType }, download }
  if (preview.kind === 'markdown' || preview.kind === 'text' || preview.kind === 'none') return { status: 'ready', file: shown, preview, download }
  // Waiting for its address, which comes with the next render.
  if (address?.bytes !== bytes) return { status: 'loading' }
  return { status: 'ready', file: shown, preview: { kind: preview.kind, url: address.url }, download }
}
