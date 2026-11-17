import { attachmentKind } from '@/files/attachmentKind'
import { previewFormat } from '@/files/previewFormat'
import { isRasterImage } from '@/files/rasterImage'
import { isSvgImage, looksLikeSvg, SVG_TYPE } from '@/files/svgImage'

/**
 * How a file is shown: by the browser, from its bytes with the type given here (`url`), as text,
 * or not at all. The type is never the file's own word for itself unless it is one of the kinds
 * the browser only displays: a file that says it is a page is shown as text, and never run. An
 * image is pixels (`isRasterImage`), or an SVG, which is a page too and so is only ever shown as
 * an image from an address of no origin (`svgImage.ts`). A PDF is drawn here page by page from its
 * bytes, a Word document, PowerPoint deck or Excel workbook (the Open XML formats) in its own layout,
 * and a CSV or TSV as a grid.
 */
export type FilePreview =
  | { kind: 'image' | 'audio' | 'video'; type: string }
  | { kind: 'markdown' | 'text'; text: string }
  | { kind: DrawnKind }
  | { kind: 'none' }

/** The files drawn from their bytes by this app's own previewers. */
export type DrawnKind = 'pdf' | 'document' | 'slides' | 'workbook' | 'delimited'

export const isDrawnKind = (kind: FilePreview['kind']): kind is DrawnKind =>
  kind === 'pdf' || kind === 'document' || kind === 'slides' || kind === 'workbook' || kind === 'delimited'

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((byte, index) => bytes[at + index] === byte)

// What a file's first bytes say it is, for one that does not say, or says something vague.
const SIGNATURES: Array<[type: string, test: (bytes: Uint8Array) => boolean]> = [
  ['image/png', (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ['image/gif', (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38])],
  ['image/webp', (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)],
  // `ftypavif`, after the box's size.
  ['image/avif', (bytes) => startsWith(bytes, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4)],
  ['application/pdf', (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])],
]
const sniff = (bytes: Uint8Array) => SIGNATURES.find(([, test]) => test(bytes))?.[0]

// An Open XML file is a ZIP package; one with a password is a compound file instead, which its
// previewer says it cannot open.
const isOfficePackage = (bytes: Uint8Array) =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** The file as text, when it is UTF-8 and not binary: nothing for anything else. */
export const decodeText = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

const isMarkdown = (name: string, mimeType: string) => mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(name)

const asText = (name: string, mimeType: string, bytes: Uint8Array): FilePreview => {
  const text = decodeText(bytes)
  if (text === undefined) return { kind: 'none' }
  return { kind: isMarkdown(name, mimeType) ? 'markdown' : 'text', text }
}

/** How to show a file, from what it says it is and what its bytes are. */
export const previewOf = (file: { name: string; mimeType: string }, bytes: Uint8Array): FilePreview => {
  const mimeType = file.mimeType.toLowerCase()
  const sniffed = sniff(bytes)
  if (!sniffed && isSvgImage({ name: file.name, type: mimeType })) {
    const text = decodeText(bytes)
    if (text !== undefined && looksLikeSvg(text)) return { kind: 'image', type: SVG_TYPE }
  }
  switch (attachmentKind({ name: file.name, type: mimeType })) {
    case 'image':
      if (isRasterImage(mimeType)) return { kind: 'image', type: mimeType }
      // Its bytes may still be pixels; otherwise it is shown as what it is written in.
      if (sniffed?.startsWith('image/')) return { kind: 'image', type: sniffed }
      return asText(file.name, mimeType, bytes)
    case 'pdf':
      return sniffed === 'application/pdf' ? { kind: 'pdf' } : { kind: 'none' }
    case 'audio':
      return { kind: 'audio', type: mimeType.startsWith('audio/') ? mimeType : 'audio/mpeg' }
    case 'video':
      return { kind: 'video', type: mimeType.startsWith('video/') ? mimeType : 'video/mp4' }
    case 'text':
    case 'code':
      return previewFormat({ name: file.name, type: mimeType }) === 'delimited' ? { kind: 'delimited' } : asText(file.name, mimeType, bytes)
    case 'spreadsheet':
    case 'document':
    case 'presentation': {
      // The Open XML formats only: the older binary files cannot be read here.
      const format = previewFormat({ name: file.name, type: mimeType })
      if (format === 'delimited') return { kind: format }
      return (format === 'document' || format === 'slides' || format === 'workbook') && isOfficePackage(bytes) ? { kind: format } : { kind: 'none' }
    }
    case 'file':
      // It says nothing useful about itself, so its bytes say.
      if (sniffed === 'application/pdf') return { kind: 'pdf' }
      if (sniffed) return { kind: 'image', type: sniffed }
      return asText(file.name, mimeType, bytes)
    default:
      return { kind: 'none' }
  }
}
