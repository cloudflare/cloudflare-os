import { useEffect, useState } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { PaneHeader } from '../chat-page/ChatPageChrome'
import { MENU_ITEM } from '../../components/menuStyles'
import { saveBytesToFile } from './saveBytes'
import { FileTypeIcon } from './LibraryViews'
import { PdfPages } from './PdfPages'

/** The file a preview pane shows. */
export type PreviewFile = {
  title: string
  mimeType: string
  loadContent: () => Promise<Uint8Array>
  /** Opens the chat the file was attached in, when the pane offers it. */
  onOpenChat?: () => void
}

/**
 * A file opened beside a list (Figma "MacBook Pro 14\" - 9"): its thumbnail and name in the pane's
 * pill, and the file itself on the pane, framed and centered. Kinds a browser can't show offer the
 * download instead.
 */
export function FilePreviewPane({ file, onClose, expanded, onExpandedChange }: {
  file: PreviewFile
  onClose: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setBytes(null)
    setUrl(null)
    setFailed(false)
    file.loadContent().then(content => {
      if (cancelled) return
      setBytes(content)
      objectUrl = URL.createObjectURL(new Blob([content as BlobPart], { type: file.mimeType }))
      setUrl(objectUrl)
    }, () => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  const download = () => { if (bytes) saveBytesToFile(bytes, file.title, file.mimeType) }
  const isText = file.mimeType.startsWith('text/') || /json|xml|yaml|csv|markdown|javascript/.test(file.mimeType)

  return (
    <>
      <PaneHeader
        glyph={url && file.mimeType.startsWith('image/')
          ? <img src={url} alt="" className="size-full object-cover" />
          : <FileTypeIcon mimeType={file.mimeType} size={13} />}
        title={file.title}
        menu={<>
          <DropdownMenu.Item disabled={!bytes} onClick={download} className={MENU_ITEM}>Download</DropdownMenu.Item>
          {file.onOpenChat && (
            <DropdownMenu.Item onClick={file.onOpenChat} className={MENU_ITEM}>Open chat</DropdownMenu.Item>
          )}
        </>}
        onExpand={() => onExpandedChange(!expanded)}
        expandLabel={expanded ? 'Exit full screen' : 'Full screen'}
        onClose={onClose}
        closeLabel="Close preview"
      />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
        {failed ? (
          <p className="text-[13px] text-kumo-subtle">This file couldn't be loaded.</p>
        ) : !url ? (
          <div className="size-6 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
        ) : file.mimeType.startsWith('image/') ? (
          <img src={url} alt={file.title} className="max-h-full max-w-full rounded-2xl object-contain ring-[3.4px] ring-inset ring-kumo-line" />
        ) : file.mimeType === 'application/pdf' && bytes ? (
          <PdfPages bytes={bytes} title={file.title} onFailed={() => setFailed(true)} />
        ) : file.mimeType.startsWith('audio/') ? (
          <audio src={url} controls className="w-full max-w-md" />
        ) : file.mimeType.startsWith('video/') ? (
          <video src={url} controls className="max-h-full max-w-full rounded-2xl" />
        ) : isText && bytes ? (
          <pre className="size-full overflow-auto whitespace-pre-wrap rounded-2xl bg-kumo-elevated p-4 font-mono text-[12px] leading-5 text-kumo-default">
            {new TextDecoder().decode(bytes)}
          </pre>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <FileTypeIcon mimeType={file.mimeType} size={32} />
            <p className="text-[13px] text-kumo-subtle">There's no preview for this kind of file.</p>
            <button type="button" onClick={download}
              className="inline-flex h-[34px] cursor-pointer items-center rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85">
              Download
            </button>
          </div>
        )}
      </div>
    </>
  )
}
