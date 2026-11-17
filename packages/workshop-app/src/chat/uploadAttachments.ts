import type { ChatAttachmentHandle, Overseer } from '@gadgets/workshop-shared/api'

// The backend's limits on what a message carries (`canonicalizeChatAttachmentRefs` and
// chat-attachment-validation.ts). Checked here too, so nothing is uploaded only to be refused.
const MAX_ATTACHMENTS = 5
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`

/** Throws, saying why, when `files` are more than one message can carry. */
export const assertAttachable = (files: readonly File[]) => {
  if (files.length > MAX_ATTACHMENTS) throw new Error(`A message can carry up to ${MAX_ATTACHMENTS} files.`)
  const tooLarge = files.find(({ size }) => size > MAX_FILE_BYTES)
  if (tooLarge) throw new Error(`${tooLarge.name || 'A file'} is larger than ${megabytes(MAX_FILE_BYTES)}, the most a file can be.`)
  if (files.reduce((total, { size }) => total + size, 0) > MAX_TOTAL_BYTES) {
    throw new Error(`The files come to more than ${megabytes(MAX_TOTAL_BYTES)}, the most a message can carry.`)
  }
}

/**
 * Uploads files into the workspace, for a message to carry: what to send with it, or nothing when
 * there are no files. Throws, before uploading any, when they are more than a message can carry.
 */
export const uploadAttachments = async (
  overseer: Pick<Overseer, 'uploadBlob'>,
  files: readonly File[],
): Promise<ChatAttachmentHandle[] | undefined> => {
  if (!files.length) return undefined
  assertAttachable(files)
  return Promise.all(files.map(async (file) => ({
    oid: await overseer.uploadBlob(new Uint8Array(await file.arrayBuffer())),
    mimeType: file.type || 'application/octet-stream',
    name: file.name || undefined,
  })))
}
