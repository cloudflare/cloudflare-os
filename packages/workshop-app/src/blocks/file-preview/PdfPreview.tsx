import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  InvalidPDFException, PasswordException, TextLayer,
  type PDFDocumentProxy, type PDFPageProxy,
} from 'pdfjs-dist'
import type { FilePreviewProps } from './previewTypes'
import { FilePreviewError } from './previewTypes'
import { canvasDensity, openPdf } from './pdfjs'
import { scrollRoot } from './scrollRoot'
import './pdfTextLayer.css'

/** Pages are drawn no wider than this, however wide the viewer: as wide as a Word document's. */
const MAX_PAGE_WIDTH = 900

/** How long a page waits for the viewer to stop being resized before it is drawn again. */
const REDRAW_DELAY = 150

/** A link on a page, where it is as fractions of the page's width and height. */
type PageLink = { url: string; left: number; top: number; width: number; height: number }

// What pdf.js throws for a file it cannot open, as the person looking at it would be told.
const openingFailure = (error: unknown) => {
  if (error instanceof PasswordException) return new FilePreviewError('This PDF needs a password. Download it to open it.')
  if (error instanceof InvalidPDFException) return new FilePreviewError('This PDF is damaged or isn’t a PDF. Download it to open it.')
  return error
}

// A page's links to web addresses. Its links to elsewhere in the file are left off: the page they
// go to is only a scroll away.
const linksOf = async (page: PDFPageProxy): Promise<PageLink[]> => {
  const viewport = page.getViewport({ scale: 1 })
  const annotations = (await page.getAnnotations({ intent: 'display' })) as Array<{ subtype?: string; url?: unknown; rect?: number[] }>
  return annotations.flatMap(({ subtype, url, rect }) => {
    if (subtype !== 'Link' || typeof url !== 'string' || !/^https?:\/\//i.test(url) || rect?.length !== 4) return []
    const [x1, y1] = viewport.convertToViewportPoint(rect[0]!, rect[1]!) as [number, number]
    const [x2, y2] = viewport.convertToViewportPoint(rect[2]!, rect[3]!) as [number, number]
    return [{
      url,
      left: Math.min(x1, x2) / viewport.width,
      top: Math.min(y1, y2) / viewport.height,
      width: Math.abs(x2 - x1) / viewport.width,
      height: Math.abs(y2 - y1) / viewport.height,
    }]
  })
}

type PdfPageProps = {
  document: PDFDocumentProxy
  /** Counted from 1, as pdf.js counts them. */
  number: number
  /** How wide it is drawn, in CSS pixels. */
  width: number
  /** Its height over its width, until the page itself is read: the first page's. */
  aspect: number
}

/**
 * One page: blank paper of its size until it nears the screen, then drawn, with its text laid over
 * it to select and its links to follow. A page scrolled far away gives its drawing up again, so a
 * long file holds no more pixels than the few pages around what is shown.
 */
const PdfPage = memo(({ document, number, width, aspect }: PdfPageProps) => {
  const pageRef = useRef<HTMLDivElement>(null)
  const drawingRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [page, setPage] = useState<PDFPageProxy>()
  const [links, setLinks] = useState<PageLink[]>([])

  useEffect(() => {
    const element = pageRef.current
    if (!element) return
    // A screen's height either side, so a page is drawn before it is scrolled to.
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), { root: scrollRoot(element), rootMargin: '100% 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Read once it is first near, and kept: what is read is only its size and how to draw it.
  useEffect(() => {
    if (!near || page) return
    let cancelled = false
    document.getPage(number).then(
      (read) => !cancelled && setPage(read),
      // A page that cannot be read stays blank: the others are still worth showing.
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [document, number, near, page])

  useEffect(() => {
    if (!page) return
    let cancelled = false
    linksOf(page).then((found) => !cancelled && setLinks(found), () => {})
    return () => {
      cancelled = true
    }
  }, [page])

  // Drawn at the screen's density for the width shown. The drawing for the old width stays,
  // stretched, until the new one is done, so resizing never shows a blank page.
  const drawn = useRef(false)
  useEffect(() => {
    const holder = drawingRef.current
    if (!holder) return
    if (!page || !near) {
      // Its pixels are let go of now, rather than whenever the canvas is collected.
      for (const canvas of holder.querySelectorAll('canvas')) canvas.width = 0
      holder.replaceChildren()
      drawn.current = false
      return
    }
    let task: ReturnType<PDFPageProxy['render']> | undefined
    const draw = () => {
      const natural = page.getViewport({ scale: 1 })
      const height = natural.height * (width / natural.width)
      const viewport = page.getViewport({ scale: (width / natural.width) * canvasDensity(width, height) })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.className = 'absolute inset-0 size-full'
      task = page.render({ canvas, viewport })
      task.promise.then(
        () => {
          for (const old of holder.querySelectorAll('canvas')) old.width = 0
          holder.replaceChildren(canvas)
          drawn.current = true
        },
        // Cancelled for a newer drawing, or failed, which leaves the page as it was.
        () => {
          canvas.width = 0
        },
      )
    }
    // Drawn straight away the first time; again only once resizing has stopped.
    const timer = drawn.current ? setTimeout(draw, REDRAW_DELAY) : (draw(), undefined)
    return () => {
      clearTimeout(timer)
      task?.cancel()
    }
  }, [page, near, width])

  // Laid out once, at the page's own size: it follows the width shown by `--total-scale-factor`.
  useEffect(() => {
    const container = textRef.current
    if (!container || !page || !near) return
    const layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: 1 }) })
    layer.render().then(
      () => {
        const end = window.document.createElement('div')
        end.className = 'endOfContent'
        container.append(end)
      },
      () => {},
    )
    // While text is being selected, the space below the last line belongs to it.
    const select = () => {
      container.classList.add('selecting')
      window.addEventListener('pointerup', () => container.classList.remove('selecting'), { once: true })
    }
    container.addEventListener('pointerdown', select)
    return () => {
      layer.cancel()
      container.removeEventListener('pointerdown', select)
      container.replaceChildren()
    }
  }, [page, near])

  const natural = page?.getViewport({ scale: 1 })
  const scale = natural ? width / natural.width : undefined
  const height = natural ? natural.height * (width / natural.width) : width * aspect

  return (
    <div
      ref={pageRef}
      role="group"
      aria-label={`Page ${number}`}
      // Paper is white in either app theme: what is drawn on it was made for white.
      className="relative shrink-0 overflow-hidden bg-white shadow-sm ring-1 ring-kumo-line"
      style={{ width, height, '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties}
    >
      <div ref={drawingRef} aria-hidden="true" />
      <div ref={textRef} className="pdf-text-layer" />
      {links.map((link) => (
        <a
          key={`${link.url}:${link.left}:${link.top}`}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          aria-label={link.url}
          className="absolute z-10 rounded-xs hover:bg-kumo-brand/10 focus-visible:outline-2 focus-visible:outline-kumo-brand"
          style={{ left: `${link.left * 100}%`, top: `${link.top * 100}%`, width: `${link.width * 100}%`, height: `${link.height * 100}%` }}
        />
      ))}
    </div>
  )
})

/**
 * A PDF drawn page by page with pdf.js, as wide as the viewer up to the width of a page, rather
 * than in the browser's own viewer: the same white sheets on the app's surface as a Word document,
 * in either theme, and the same in every browser. Its text can be selected, copied and found, its
 * links to the web followed, and which page is in view is said at the bottom while there are more.
 */
export const PdfPreview = ({ bytes }: FilePreviewProps) => {
  const [opened, setOpened] = useState<{ bytes: Uint8Array; document?: PDFDocumentProxy; aspect?: number; error?: unknown }>()
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [current, setCurrent] = useState(1)

  useEffect(() => {
    const task = openPdf(bytes)
    task.promise
      .then(async (document) => {
        const first = (await document.getPage(1)).getViewport({ scale: 1 })
        setOpened({ bytes, document, aspect: first.height / first.width })
      })
      .catch((error: unknown) => {
        // A task destroyed before the file was open says so; nothing is shown for it by then.
        if (!task.destroyed) setOpened({ bytes, error })
      })
    return () => void task.destroy()
  }, [bytes])

  const document = opened?.bytes === bytes ? opened.document : undefined
  const pages = document?.numPages ?? 0

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width)))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [document])

  // The page in view is the one across the middle of what is shown.
  useEffect(() => {
    const container = containerRef.current
    const root = container && scrollRoot(container)
    // Pages are only laid out once the width is known, so it is followed from then.
    if (!container || !root || pages < 2 || width === 0) return
    let frame = 0
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const { top, height } = root.getBoundingClientRect()
        const middle = top + height / 2
        const index = [...container.children].findIndex((page) => page.getBoundingClientRect().bottom >= middle)
        setCurrent(index === -1 ? pages : index + 1)
      })
    }
    follow()
    root.addEventListener('scroll', follow, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', follow)
    }
  }, [pages, width])

  if (opened?.bytes === bytes && opened.error !== undefined) throw openingFailure(opened.error)
  if (!document || !opened?.aspect) return <p role="status" className="appears-late p-6 text-center text-base text-kumo-subtle">Opening…</p>

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 px-4 py-4">
        <div ref={containerRef} className="flex flex-col items-center gap-3">
          {width > 0 && Array.from({ length: pages }, (_, index) => (
            <PdfPage key={index} document={document} number={index + 1} width={width} aspect={opened.aspect!} />
          ))}
        </div>
      </div>
      {pages > 1 && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center pb-1">
          <span className="rounded-full bg-kumo-elevated px-2.5 py-1 text-xs text-kumo-subtle tabular-nums shadow-sm ring-1 ring-kumo-line">
            Page {current} of {pages}
          </span>
        </div>
      )}
    </div>
  )
}
