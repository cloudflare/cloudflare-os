import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { attachmentKind } from '@/files/attachmentKind'
import { useImageUrl } from '@/hooks/useImageUrl'
import { ATTACHMENT_KIND_ICONS } from './attachmentKindIcons'

export type MessageAttachmentProps = {
  name: string
  mimeType: string
  /** The file's bytes, when it is an image small enough to have been sent along. */
  content?: Uint8Array
  onOpen: () => void
}

/** A file sent with a message: its picture when there is one, otherwise a tile naming its kind. */
export const MessageAttachment = ({ name, mimeType, content, onOpen }: MessageAttachmentProps) => {
  const url = useImageUrl(content, { name, type: mimeType })
  // What says it is an image may not draw as one, and is then a tile.
  const [failed, setFailed] = useState<string>()
  const preview = url !== failed ? url : undefined
  const KindIcon = ATTACHMENT_KIND_ICONS[attachmentKind({ name, type: mimeType })]

  return (
    <button
      type="button"
      onClick={onOpen}
      title={name}
      aria-label={`Open ${name}`}
      className={cn(
        'relative size-22 shrink-0 overflow-hidden rounded-2xl bg-kumo-base text-left ring-1 ring-kumo-line ring-inset',
        // Laid over what is shown, so a picture darkens on hover as a tile does.
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] after:transition-colors motion-reduce:after:transition-none hover:after:bg-kumo-contrast/8",
      )}
    >
      {preview ? (
        <img src={preview} alt="" className="size-full object-cover" onError={() => setFailed(preview)} />
      ) : (
        <span className="flex h-full flex-col justify-between gap-2 p-3">
          <KindIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
          <span className="line-clamp-2 text-xs/4 font-medium wrap-anywhere text-kumo-default">{name}</span>
        </span>
      )}
    </button>
  )
}
