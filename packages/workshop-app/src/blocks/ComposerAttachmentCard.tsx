import { useCallback, useState } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { Button, Tooltip } from '@gadgets/ui'
import { attachmentKind } from '@/files/attachmentKind'
import { previewFormat } from '@/files/previewFormat'
import { useImageUrl } from '@/hooks/useImageUrl'
import { AttachmentTileFace } from './AttachmentTileFace'
import { useFileThumbnail } from './file-preview/useFileThumbnail'
import type { ComposerAttachment } from './useComposerAttachments'

/**
 * A file about to be sent: its picture, or a glimpse of its first page, slide or sheet, drawn from
 * the file on this device before it is uploaded.
 */
export const ComposerAttachmentCard = ({ attachment, onRemove }: {
  attachment: ComposerAttachment
  onRemove: () => void
}) => {
  const { file } = attachment
  const [previewFailed, setPreviewFailed] = useState(false)
  const previewUrl = useImageUrl(file, file)
  const name = file.name || 'Attached file'
  const picture = previewUrl && !previewFailed
  const load = useCallback(async () => new Uint8Array(await file.arrayBuffer()), [file])
  const { ref, thumbnail } = useFileThumbnail<HTMLDivElement>(picture ? undefined : previewFormat(file), load)

  return (
    <Tooltip content={name}>
      <div ref={ref} className="group relative size-22 overflow-hidden rounded-2xl bg-kumo-base sm:size-26">
        {picture ? (
          <img
            src={previewUrl}
            alt={name}
            className="size-full object-contain"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <AttachmentTileFace name={name} kind={attachmentKind(file)} thumbnail={thumbnail} />
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-kumo-line ring-inset" />
        <Button
          icon={<Cancel01Icon weight="bold" />}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="absolute top-1 right-1 size-6 bg-kumo-canvas transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [&>svg]:size-3"
        />
      </div>
    </Tooltip>
  )
}
