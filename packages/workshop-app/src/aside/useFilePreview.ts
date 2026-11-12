import { useEffect, useMemo, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import type { AsideFile } from './asideItems'
import { previewOf, type FilePreview } from './filePreview'

/** How a file is shown, with an address for its bytes where the browser shows them. */
export type ShownFile =
  | { kind: 'image' | 'pdf' | 'audio' | 'video'; url: string }
  | Exclude<FilePreview, { type: string }>

export type FileState =
  | { status: 'loading' }
  /** Its bytes cannot be reached: there is no chat to fetch them through. */
  | { status: 'unreachable' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      preview: ShownFile
      /** Saves it to this device, as it was sent. */
      download: () => void
    }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const save = (bytes: Uint8Array, name: string) => {
  // As bytes and nothing else, so that it is saved rather than opened.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * A file sent in a chat, ready to show: the bytes it came with, or else fetched through the chat,
 * and how to show them (`previewOf`). Nothing, for no file. Showing another starts over.
 */
export const useFilePreview = (file: AsideFile | undefined): FileState => {
  const { api } = useApi()
  const key = file && `${file.workspaceId}/${file.chatId}/${file.id}`
  // What was fetched, for the file it was fetched for.
  const [fetched, setFetched] = useState<{ key: string; bytes?: Uint8Array; error?: string }>()
  const inline = file?.content
  const workspaceId = file?.workspaceId
  const chatId = file?.chatId
  const fileId = file?.id

  useEffect(() => {
    if (!key || inline || workspaceId === undefined || chatId === undefined || fileId === undefined) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    overseer.getChatAttachmentContent(chatId, fileId).then(
      (bytes) => {
        if (!cancelled) setFetched({ key, bytes })
      },
      (error: unknown) => {
        if (!cancelled) setFetched({ key, error: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, key, inline, workspaceId, chatId, fileId])

  const current = fetched?.key === key ? fetched : undefined
  const bytes = inline ?? current?.bytes
  const name = file?.name ?? 'File'
  const mimeType = file?.mimeType ?? ''
  const preview = useMemo(() => bytes && previewOf({ name, mimeType }, bytes), [bytes, name, mimeType])

  // An address for the bytes, for as long as they are shown.
  const [address, setAddress] = useState<{ bytes: Uint8Array; url: string }>()
  const type = preview && 'type' in preview ? preview.type : undefined
  useEffect(() => {
    if (!bytes || !type) return
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
  const download = () => save(bytes, name)
  if (!('type' in preview)) return { status: 'ready', preview, download }
  // Waiting for its address, which comes with the next render.
  if (address?.bytes !== bytes) return { status: 'loading' }
  return { status: 'ready', preview: { kind: preview.kind, url: address.url }, download }
}
