import { useRef, useState, type DragEvent } from 'react'

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

/** Counts nested enters/leaves so moving over a child does not clear the highlight. */
export const useComposerAttachmentDrop = (onFiles: (files: FileList) => void) => {
  const [isActive, setIsActive] = useState(false)
  const depth = useRef(0)

  return {
    isActive,
    onDragEnter: (event: DragEvent<HTMLFormElement>) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current++
      setIsActive(true)
    },
    onDragOver: (event: DragEvent<HTMLFormElement>) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: DragEvent<HTMLFormElement>) => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setIsActive(false)
    },
    onDrop: (event: DragEvent<HTMLFormElement>) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current = 0
      setIsActive(false)
      onFiles(event.dataTransfer.files)
    },
  }
}
