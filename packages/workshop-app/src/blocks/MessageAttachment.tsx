import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { attachmentKind } from '@/files/attachmentKind'
import { previewFormat } from '@/files/previewFormat'
import { useImageUrl } from '@/hooks/useImageUrl'
import { AttachmentTileFace } from './AttachmentTileFace'
import { useFileThumbnail } from './file-preview/useFileThumbnail'

export type MessageAttachmentProps = {
  name: string
  mimeType: string
  /** The file's bytes, when it is an image small enough to have been sent along. */
  content?: Uint8Array
  /** Fetches the file's bytes, for a glimpse of a document, deck, sheet, PDF or text. */
  load?: () => Promise<Uint8Array>
  onOpen: () => void
}

/**
 * A file sent with a message: its picture when there is one, a glimpse of its first page, slide or
 * sheet once that is drawn, otherwise a tile naming its kind.
 */
export const MessageAttachment = ({ name, mimeType, content, load, onOpen }: MessageAttachmentProps) => {
  const url = useImageUrl(content, { name, type: mimeType })
  // What says it is an image may not draw as one, and is then a tile.
  const [failed, setFailed] = useState<string>()
  const preview = url !== failed ? url : undefined
  const file = { name, type: mimeType }
  const { ref, thumbnail } = useFileThumbnail<HTMLButtonElement>(preview ? undefined : previewFormat(file), load)

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      title={name}
      aria-label={`Open ${name}`}
      className={cn(
        'relative size-22 shrink-0 overflow-hidden rounded-2xl bg-kumo-base text-left',
        // Laid over what is shown, so a picture darkens on hover as a tile does.
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] after:transition-colors motion-reduce:after:transition-none hover:after:bg-kumo-contrast/8",
        // The ring is laid over what is shown, which would otherwise cover it.
        "before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-[inherit] before:ring-1 before:ring-kumo-line before:ring-inset before:content-['']",
      )}
    >
      {preview ? (
        <img src={preview} alt="" className="size-full object-cover" onError={() => setFailed(preview)} />
      ) : (
        <AttachmentTileFace name={name} kind={attachmentKind(file)} thumbnail={thumbnail} />
      )}
    </button>
  )
}
