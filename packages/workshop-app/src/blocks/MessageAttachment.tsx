import { useEffect, useState } from 'react'
import { attachmentKind } from './attachmentKind'
import { ATTACHMENT_KIND_ICONS } from './attachmentKindIcons'

export type MessageAttachmentProps = {
  name: string
  mimeType: string
  /** The file's bytes, when it is an image small enough to have been sent along. */
  content?: Uint8Array
  onOpen: () => void
}

/** An object URL for `content`, released when the bytes change or the component goes away. */
const useObjectUrl = (content: Uint8Array | undefined, type: string) => {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!content) return
    const created = URL.createObjectURL(new Blob([new Uint8Array(content)], { type }))
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(undefined)
    }
  }, [content, type])
  return url
}

/** A file sent with a message: its picture when there is one, otherwise a tile naming its kind. */
export const MessageAttachment = ({ name, mimeType, content, onOpen }: MessageAttachmentProps) => {
  const isImage = mimeType.startsWith('image/')
  const preview = useObjectUrl(isImage ? content : undefined, mimeType)
  const KindIcon = ATTACHMENT_KIND_ICONS[attachmentKind({ name, type: mimeType })]

  return (
    <button
      type="button"
      onClick={onOpen}
      title={name}
      aria-label={`Open ${name}`}
      className="relative size-22 shrink-0 overflow-hidden rounded-2xl bg-kumo-base text-left ring-1 ring-kumo-line ring-inset hover:bg-kumo-tint"
    >
      {preview ? (
        <img src={preview} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex h-full flex-col justify-between gap-2 p-3">
          <KindIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
          <span className="line-clamp-2 text-xs/4 font-medium wrap-anywhere text-kumo-default">{name}</span>
        </span>
      )}
    </button>
  )
}
