import type { AttachmentKind } from '@/files/attachmentKind'
import { AttachmentKindIcon } from './AttachmentKindIcon'
import type { FileThumbnail } from './file-preview/useFileThumbnail'

/**
 * What a file's tile shows when the file is not itself a picture: a glimpse of its content once
 * there is one, faded in over nothing, and until then (or when there is none) its kind's icon
 * above its name.
 */
export const AttachmentTileFace = ({ name, kind, thumbnail }: { name: string; kind: AttachmentKind; thumbnail: FileThumbnail | null }) => {
  if (!thumbnail) {
    return (
      <span className="flex h-full flex-col justify-between gap-2 p-3">
        <AttachmentKindIcon kind={kind} className="size-5" />
        <span className="line-clamp-2 text-xs/4 font-medium wrap-anywhere text-kumo-default">{name}</span>
      </span>
    )
  }
  // A thumbnail fills its tile, as a picture does; the tile's label carries the name.
  switch (thumbnail.type) {
    case 'image':
      return <img src={thumbnail.url} alt="" className={`appears block size-full bg-kumo-base ${thumbnail.whole ? 'object-contain' : 'object-cover object-top'}`} />
    case 'view':
      return <span className="appears block size-full bg-kumo-base">{thumbnail.view}</span>
    case 'text':
      return (
        // Too small to read by design: the shape of the text, as a page seen from across a room.
        <span aria-hidden="true" className="appears block size-full overflow-hidden bg-kumo-base px-2 pt-2 font-mono text-[5px]/[7px] whitespace-pre text-kumo-subtle select-none">
          {thumbnail.text}
        </span>
      )
  }
}
