import { useEffect, useState } from 'react'
import type { BytesRef } from '@gadgets/workshop-shared/code-change'
import { WorkshopButton } from '../../components/WorkshopControls'
import { formatAttachmentSize } from '../chat/attachmentFormatting'

// Image types an <img> renders, by file extension. SVG is text, so it never arrives as a blob.
const IMAGE_TYPES: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}

type BinaryFileViewProps = {
  filename: string
  blob: BytesRef
  readBlob: (oid: string) => Promise<ReadableStream<Uint8Array>>
}

/** A file that is not text: the image itself for an image type, else a note to download it. */
export const BinaryFileView = ({ filename, blob, readBlob }: BinaryFileViewProps) => {
  const imageType = IMAGE_TYPES[filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()]
  // The loaded image's object URL, null when its read failed.
  const [image, setImage] = useState<{ oid: string, url: string | null }>()
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    if (imageType === undefined) return
    let stale = false
    readBlob(blob.oid)
      .then(stream => new Response(stream, { headers: { 'Content-Type': imageType } }).blob())
      .then(data => {
        if (!stale) setImage({ oid: blob.oid, url: URL.createObjectURL(data) })
      }, () => {
        if (!stale) setImage({ oid: blob.oid, url: null })
      })
    return () => { stale = true }
  }, [blob.oid, imageType, readBlob, retryToken])

  // An object URL lives exactly as long as the state that renders it.
  const imageUrl = image?.url
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl)
  }, [imageUrl])

  if (imageType === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-kumo-base px-6 text-center text-sm text-kumo-subtle">
        Binary file ({formatAttachmentSize(blob.byteLength)}). Download it to open it.
      </div>
    )
  }
  const loaded = image?.oid === blob.oid ? image : undefined
  if (loaded === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-kumo-base text-kumo-subtle">
        Loading image...
      </div>
    )
  }
  if (loaded.url === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-kumo-base px-6 text-center">
        <p className="m-0 text-sm text-kumo-danger">Failed to load this image.</p>
        <WorkshopButton
          tone="secondary"
          className="!h-8"
          onClick={() => {
            setImage(undefined)
            setRetryToken(token => token + 1)
          }}
        >
          Try again
        </WorkshopButton>
      </div>
    )
  }
  return (
    <div className="h-full bg-kumo-base p-4">
      <img src={loaded.url} alt={filename} className="h-full w-full object-contain" />
    </div>
  )
}
