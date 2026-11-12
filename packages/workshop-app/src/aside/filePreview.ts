import { attachmentKind } from '@/blocks/attachmentKind'

/**
 * How a file is shown: by the browser, from its bytes with the type given here (`url`), as text,
 * or not at all. The type is never the file's own word for itself unless it is one of the kinds
 * the browser only displays: a file that says it is a page is shown as text, and never run.
 */
export type FilePreview =
  | { kind: 'image' | 'pdf' | 'audio' | 'video'; type: string }
  | { kind: 'markdown' | 'text'; text: string }
  | { kind: 'none' }

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((byte, index) => bytes[at + index] === byte)

// What a file's first bytes say it is, for one that does not say, or says something vague.
const SIGNATURES: Array<[type: string, test: (bytes: Uint8Array) => boolean]> = [
  ['image/png', (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ['image/gif', (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38])],
  ['image/webp', (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)],
  ['application/pdf', (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])],
]
const sniff = (bytes: Uint8Array) => SIGNATURES.find(([, test]) => test(bytes))?.[0]

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
  switch (attachmentKind({ name: file.name, type: mimeType })) {
    case 'image':
      // An image element runs nothing, whatever the image is.
      return { kind: 'image', type: mimeType.startsWith('image/') ? mimeType : sniffed ?? 'image/png' }
    case 'pdf':
      return sniffed === 'application/pdf' ? { kind: 'pdf', type: sniffed } : { kind: 'none' }
    case 'audio':
      return { kind: 'audio', type: mimeType.startsWith('audio/') ? mimeType : 'audio/mpeg' }
    case 'video':
      return { kind: 'video', type: mimeType.startsWith('video/') ? mimeType : 'video/mp4' }
    case 'text':
    case 'code':
      return asText(file.name, mimeType, bytes)
    case 'spreadsheet':
      // Only the spreadsheets that are text.
      return /\.(csv|tsv)$/i.test(file.name) || mimeType === 'text/csv' ? asText(file.name, mimeType, bytes) : { kind: 'none' }
    case 'file':
      // It says nothing useful about itself, so its bytes say.
      if (sniffed === 'application/pdf') return { kind: 'pdf', type: sniffed }
      if (sniffed) return { kind: 'image', type: sniffed }
      return asText(file.name, mimeType, bytes)
    default:
      return { kind: 'none' }
  }
}
