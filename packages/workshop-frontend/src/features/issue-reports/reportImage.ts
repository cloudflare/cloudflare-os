import {
  ISSUE_REPORT_IMAGE_TYPES,
  MAX_ISSUE_REPORT_IMAGE_BYTES,
} from '@gadgets/workshop-shared/api'

/** The `accept` of a file input that takes an issue report's images. */
export const REPORT_IMAGE_ACCEPT = ISSUE_REPORT_IMAGE_TYPES.join(',')

const MAX_MEBIBYTES = MAX_ISSUE_REPORT_IMAGE_BYTES / (1024 * 1024)

// The sizes an image over the bound is tried at, as a share of its width and height, largest
// first: the picture is sent as large as fits.
const SCALES = [1, 0.75, 0.5, 0.35, 0.25]

const ENCODING_QUALITY = 0.9

const hasReportImageType = (type: string): boolean =>
  (ISSUE_REPORT_IMAGE_TYPES as readonly string[]).includes(type)

const encode = (canvas: HTMLCanvasElement, type: string): Promise<Blob | null> =>
  new Promise((resolve) => { canvas.toBlob(resolve, type, ENCODING_QUALITY) })

/**
 * An image as an issue report takes it: the file itself when it is a PNG, JPEG or WebP within
 * MAX_ISSUE_REPORT_IMAGE_BYTES, and otherwise a re-encoding of it that fits (WebP, at the
 * largest size that does). Rejects, saying why, for a file of another type and for an image
 * that cannot be made to fit. The type is the one the browser gave the file: the server decides
 * again from the bytes.
 */
export const prepareReportImage = async (image: Blob): Promise<Blob> => {
  if (!hasReportImageType(image.type)) {
    throw new Error('Only PNG, JPEG and WebP images can be attached.')
  }
  if (image.size <= MAX_ISSUE_REPORT_IMAGE_BYTES) return image

  const tooLarge = new Error(`This image is over ${MAX_MEBIBYTES} MiB and could not be made smaller.`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(image)
  } catch {
    throw tooLarge
  }
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (context === null) throw tooLarge
    for (const scale of SCALES) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      // A browser that cannot encode WebP answers with a PNG, which a smaller size still shrinks.
      const encoded = await encode(canvas, 'image/webp')
      if (encoded !== null && encoded.size <= MAX_ISSUE_REPORT_IMAGE_BYTES) return encoded
    }
    throw tooLarge
  } finally {
    bitmap.close()
  }
}
