import { useEffect, useRef, useState } from 'react'

export type ComposerAttachment = {
  id: string
  file: File
  previewUrl?: string
}

/** Local draft files. Object URLs live only as long as their attachment does. */
export const useComposerAttachments = () => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const current = useRef<ComposerAttachment[]>([])

  const update = (next: ComposerAttachment[]) => {
    current.current = next
    setAttachments(next)
  }

  useEffect(() => () => {
    for (const attachment of current.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])

  const addFiles = (files: FileList | File[]) => {
    update([
      ...current.current,
      ...Array.from(files, (file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      })),
    ])
  }

  const removeAttachment = (id: string) => {
    const attachment = current.current.find((item) => item.id === id)
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    update(current.current.filter((item) => item.id !== id))
  }

  const clearAttachments = () => {
    for (const attachment of current.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    }
    update([])
  }

  return { attachments, addFiles, removeAttachment, clearAttachments }
}
