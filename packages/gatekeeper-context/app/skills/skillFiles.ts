// What a skill's files are, as the Context Library keeps them (text as it is written, anything
// else as base64), and how they are read from the browser and said where they are listed.

import { isTextContentType } from '../../src/context-types'
import { readUploadFile, type DecodedUploadFile } from '../uploadFiles'

/** One of a skill's files, as it is kept: its path in the skill, with `/` between folders. */
export type SkillFile = DecodedUploadFile

/** The file that makes a skill one: its name and what it is for, over its instructions. */
export const MANIFEST = 'SKILL.md'

export const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path)

/** A file's name, without the folders it is in. */
export const fileName = (path: string) => path.split('/').at(-1) ?? path

/** Whether a file is one a folder is chosen with that nobody put there, such as `.DS_Store`: it, or a folder it is in, starts with a dot. */
export const isHiddenUpload = (file: File) => (file.webkitRelativePath || file.name).split('/').some((part) => part.startsWith('.'))

/**
 * Reads the files one after another, so that several are not held in memory twice over at once,
 * each at its path in the folder it was chosen with. Hidden ones are left out (`isHiddenUpload`),
 * and one whose extension is not known is kept by what its bytes are, not taken for Markdown.
 */
export const readUploadFiles = async (files: Iterable<File>): Promise<SkillFile[]> => {
  const result: SkillFile[] = []
  for (const file of files) if (!isHiddenUpload(file)) result.push(await readUploadFile(file, undefined, { inferUnknownBinary: true }))
  return result
}

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
