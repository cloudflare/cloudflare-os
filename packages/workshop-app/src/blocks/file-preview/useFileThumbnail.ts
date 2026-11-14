import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PreviewFormat } from '@/files/previewFormat'
import { decodeText } from './decodeText'
import { scrollRoot } from './scrollRoot'

/**
 * A tile-sized glimpse of a file: the start of its text, a picture of its first page, or its first
 * page, slide or sheet drawn by the file's own previewer.
 */
export type FileThumbnail =
  | { type: 'text'; text: string }
  | { type: 'view'; view: ReactNode }
  /** `whole` shows all of a wide page, as a slide is shown; otherwise the tile shows the page's top. */
  | { type: 'image'; url: string; whole: boolean }

/** The width a tile's picture is drawn for: the larger tile size. */
const THUMBNAIL_WIDTH = 104
const TEXT_LINES = 18
const TEXT_COLUMNS = 64

/** Text cut to the lines and columns a tile can show. */
const clip = (text: string): string => text.split(/\r\n|\r|\n/, TEXT_LINES).map((line) => line.slice(0, TEXT_COLUMNS)).join('\n')

const view = (drawn: ReactNode): FileThumbnail | null => (drawn ? { type: 'view', view: drawn } : null)

const makeThumbnail = async (format: PreviewFormat, bytes: Uint8Array, signal: AbortSignal): Promise<FileThumbnail | null> => {
  switch (format) {
    case 'text':
    case 'delimited': {
      // A tile with nothing on it says less than the file's icon and name.
      const text = clip(decodeText(bytes.subarray(0, 4096)))
      return text.trim() === '' ? null : { type: 'text', text }
    }
    // Each renderer loads only once such a file is on screen, pdf.js above all.
    case 'document': {
      const { documentThumbnail } = await import('./DocumentThumbnail')
      return view(await documentThumbnail(bytes, signal))
    }
    case 'slides': {
      const { slideThumbnail } = await import('./SlideThumbnail')
      return view(await slideThumbnail(bytes, signal))
    }
    case 'workbook': {
      const { sheetThumbnail } = await import('./SheetThumbnail')
      return view(await sheetThumbnail(bytes, signal))
    }
    case 'pdf': {
      const { pdfThumbnail } = await import('./pdfThumbnail')
      const { image, landscape } = await pdfThumbnail(bytes, THUMBNAIL_WIDTH, signal)
      return { type: 'image', url: URL.createObjectURL(image), whole: landscape }
    }
  }
}

/**
 * A thumbnail for the tile `ref` is attached to, made once the tile nears the screen: a long
 * chat's files are not all fetched to draw tiles nobody scrolls to. Null until it is ready, and
 * for a file with none or one that could not be read, where the tile shows the file's kind.
 * `load` gives the file's bytes; nothing is made without it.
 */
export const useFileThumbnail = <E extends Element>(format: PreviewFormat | undefined, load: (() => Promise<Uint8Array>) | undefined) => {
  const ref = useRef<E>(null)
  const [thumbnail, setThumbnail] = useState<FileThumbnail | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const loadable = load !== undefined

  useEffect(() => {
    const element = ref.current
    if (!element || !format || !loadable) return
    let cancelled = false
    let url: string | undefined
    // A tile gone before its file arrives, or while it is being read, stops the read.
    const abort = new AbortController()
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      Promise.resolve(loadRef.current?.())
        .then((bytes) => (cancelled || !bytes ? null : makeThumbnail(format, bytes, abort.signal)))
        .then((made) => {
          if (made?.type === 'image') url = made.url
          if (cancelled) {
            if (url) URL.revokeObjectURL(url)
          } else {
            setThumbnail(made)
          }
        })
        // The tile keeps its icon; opening the file says what is wrong with it.
        .catch(() => {})
    }, { root: scrollRoot(element), rootMargin: '200px' })
    observer.observe(element)
    return () => {
      cancelled = true
      abort.abort()
      observer.disconnect()
      if (url) URL.revokeObjectURL(url)
      setThumbnail(null)
    }
  }, [format, loadable])

  return { ref, thumbnail }
}
