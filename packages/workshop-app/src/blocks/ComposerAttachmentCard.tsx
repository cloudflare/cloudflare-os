import { useState } from 'react'
import {
  FileAudioIcon, FileCodeIcon, FileDocIcon, FileIcon, FileImageIcon, FilePdfIcon,
  FilePptIcon, FileTextIcon, FileVideoIcon, FileXlsIcon, FileZipIcon, XIcon, type Icon,
} from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Tooltip } from '@/components/Tooltip'
import { attachmentKind, type AttachmentKind } from './attachmentKind'
import type { ComposerAttachment } from './useComposerAttachments'

const KIND_ICONS: Record<AttachmentKind, Icon> = {
  image: FileImageIcon,
  pdf: FilePdfIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  spreadsheet: FileXlsIcon,
  document: FileDocIcon,
  presentation: FilePptIcon,
  archive: FileZipIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileIcon,
}

export const ComposerAttachmentCard = ({ attachment, onRemove }: {
  attachment: ComposerAttachment
  onRemove: () => void
}) => {
  const [previewFailed, setPreviewFailed] = useState(false)
  const name = attachment.file.name || 'Attached file'
  const KindIcon = KIND_ICONS[attachmentKind(attachment.file)]

  return (
    <Tooltip content={name}>
      <div className="group relative size-22 overflow-hidden rounded-2xl bg-kumo-base sm:size-26">
        {attachment.previewUrl && !previewFailed ? (
          <img
            src={attachment.previewUrl}
            alt={name}
            className="size-full object-contain"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <div className="flex h-full flex-col justify-between gap-2 p-3">
            <KindIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
            <span className="line-clamp-2 text-xs/4 font-medium wrap-anywhere text-kumo-default">{name}</span>
          </div>
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-kumo-line ring-inset" />
        <Button
          icon={<XIcon weight="bold" />}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="absolute top-1 right-1 size-6 bg-kumo-canvas transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [&>svg]:size-3"
        />
      </div>
    </Tooltip>
  )
}
