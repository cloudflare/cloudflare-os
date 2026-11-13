import { cn } from '@cloudflare/kumo/utils'
import { attachmentKind } from '@/files/attachmentKind'
import { isRasterImage } from '@/files/rasterImage'
import { useObjectUrl } from '@/hooks/useObjectUrl'
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
  // Only pixels: the picture can be opened in a tab of its own, as the app's origin.
  const preview = useObjectUrl(isRasterImage(mimeType) ? content : undefined, mimeType)
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
