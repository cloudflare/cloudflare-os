import { useState } from 'react'

export type ComposerAttachment = {
  id: string
  file: File
}

const attach = (file: File): ComposerAttachment => ({ id: crypto.randomUUID(), file })

/** Local draft files, starting with `initial`. Each card makes its own preview of its file. */
export const useComposerAttachments = (initial: readonly File[] = []) => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => initial.map(attach))

  const addFiles = (files: FileList | File[]) => {
    const added = Array.from(files, attach)
    setAttachments((current) => [...current, ...added])
  }

  const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => item.id !== id))

  const clearAttachments = () => setAttachments([])

  return { attachments, addFiles, removeAttachment, clearAttachments }
}
