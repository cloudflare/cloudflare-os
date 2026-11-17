// How a skill's files are read from the browser and kept, ported from the Context Library
// (`gatekeeper-context/app/uploadFiles.ts` and `src/context-types.ts`), so that what is uploaded
// here is what it stores: text as it is written, and anything else as base64.

/** One of a skill's files, as it is kept. */
export type SkillFile = {
  /** Where it is in the skill, with `/` between folders: "SKILL.md", "templates/report.md". */
  path: string
  contentType: string
  /** What is in it: as written for text (`isTextContentType`), and base64 otherwise. */
  body: string
}

/** The file that makes a skill one: its name and what it is for, over its instructions. */
export const MANIFEST = 'SKILL.md'

const DEFAULT_CONTENT_TYPE = 'text/markdown'
const TEXT = 'text/plain'

// File extensions (without the dot, lowercased) by the type they are kept as. Code and config are
// plain text.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: TEXT,
  text: TEXT,
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  ...Object.fromEntries(
    ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'lua'].map(
      (extension) => [extension, TEXT],
    ),
  ),
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
}

/** A file's type from its path's extension, Markdown where it has none that is known. */
export const contentTypeFromPath = (path: string): string => {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return DEFAULT_CONTENT_TYPE
  return EXTENSION_CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}

/** Whether a type's body is kept as written. Everything else is base64; SVG is an image. */
export const isTextContentType = (contentType: string): boolean => {
  const type = contentType.split(';', 1)[0].trim().toLowerCase()
  return type.startsWith('text/') || ['application/json', 'application/yaml', 'application/x-yaml', 'application/xml'].includes(type)
}

export const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path)

/** A file's name, without the folders it is in. */
export const fileName = (path: string) => path.split('/').at(-1) ?? path

/** Reads a browser file as base64 without creating a size-limited data URL. */
export const fileToBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Divisible by three, so that chunks encoded on their own join up.
  const chunkSize = 24_576
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return result
}

/**
 * Reads one chosen file as it is kept, at its path in the folder it was chosen with, when it was
 * chosen with one. An extension that is not known is not taken for Markdown, as a path alone is:
 * the browser's word for its type is gone by, and with none, whether its bytes are text.
 */
export const readUploadFile = async (file: File, pathOverride?: string): Promise<SkillFile> => {
  const path = pathOverride || file.webkitRelativePath || file.name
  const pathContentType = contentTypeFromPath(path)
  if (pathContentType !== DEFAULT_CONTENT_TYPE || isMarkdownPath(path)) {
    return { path, contentType: pathContentType, body: isTextContentType(pathContentType) ? await file.text() : await fileToBase64(file) }
  }
  if (file.type) return { path, contentType: file.type, body: isTextContentType(file.type) ? await file.text() : await fileToBase64(file) }
  try {
    return { path, contentType: TEXT, body: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
  } catch {
    return { path, contentType: 'application/octet-stream', body: await fileToBase64(file) }
  }
}

/** Whether a file is one a folder is chosen with that nobody put there, such as `.DS_Store`: it, or a folder it is in, starts with a dot. */
export const isHiddenUpload = (file: File) => (file.webkitRelativePath || file.name).split('/').some((part) => part.startsWith('.'))

/**
 * Reads the files one after another, so that several are not held in memory twice over at once.
 * Hidden ones are left out (`isHiddenUpload`).
 */
export const readUploadFiles = async (files: Iterable<File>): Promise<SkillFile[]> => {
  const result: SkillFile[] = []
  for (const file of files) if (!isHiddenUpload(file)) result.push(await readUploadFile(file))
  return result
}

/** A file's bytes, as it would be saved. */
export const fileBytes = ({ contentType, body }: SkillFile): Uint8Array<ArrayBuffer> =>
  isTextContentType(contentType) ? new TextEncoder().encode(body) : Uint8Array.from(atob(body), (character) => character.charCodeAt(0))

/** How big a file is, in bytes. */
export const fileSize = (file: SkillFile) => (isTextContentType(file.contentType) ? new TextEncoder().encode(file.body).length : Math.floor((file.body.replace(/=+$/, '').length * 3) / 4))

/** How big, as it is said: "512 B", "1.4 KB", "2.1 MB". */
export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What a file is, in a word or two, for where it is listed. */
export const fileKind = ({ path, contentType }: SkillFile) => {
  if (isMarkdownPath(path) || contentType === 'text/markdown') return 'Markdown'
  if (contentType.startsWith('image/')) return 'Image'
  if (contentType === 'application/pdf') return 'PDF'
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toUpperCase() : ''
  if (isTextContentType(contentType)) return extension ? `${extension} text` : 'Text'
  return extension ? `${extension} file` : 'File'
}
