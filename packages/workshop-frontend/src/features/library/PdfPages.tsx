import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// pdf.js loads only once a PDF is opened, and draws into canvases: the page's CSP lets frames show
// only srcdoc (which keeps gadget frames from navigating away), so a blob: frame can't show one.
const loadPdfJs = async () => {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/** Opens a PDF's bytes; the document is destroyed when the caller is done with it. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs()
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  return await pdfjs.getDocument({ data: bytes.slice() }).promise
}

/** Draws page `index` (from 1) of `pdf` into `canvas`, `width` CSS pixels wide. */
export async function drawPdfPage(pdf: PDFDocumentProxy, index: number, canvas: HTMLCanvasElement,
  width: number): Promise<void> {
  const page = await pdf.getPage(index)
  const base = page.getViewport({ scale: 1 })
  const ratio = window.devicePixelRatio || 1
  const viewport = page.getViewport({ scale: (width / base.width) * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvas, viewport }).promise
}

/** A PDF's first page as an image, `width` CSS pixels wide: its thumbnail. */
export async function pdfThumbnail(bytes: Uint8Array, width = 320): Promise<Blob | null> {
  const pdf = await openPdf(bytes)
  try {
    const canvas = document.createElement('canvas')
    await drawPdfPage(pdf, 1, canvas, width)
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  } finally {
    void pdf.destroy()
  }
}

/**
 * A PDF on the preview pane: its pages as sheets down the pane, each drawn as it nears view at
 * the pane's width, so a long document opens at once and scrolls lightly.
 */
export function PdfPages({ bytes, title, onFailed }: {
  bytes: Uint8Array
  title: string
  onFailed: () => void
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([])
  const failed = useRef(onFailed)
  failed.current = onFailed

  useEffect(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    openPdf(bytes).then(async document => {
      opened = document
      if (cancelled) { void document.destroy(); return }
      // Page shapes up front, so every sheet holds its place before it is drawn.
      const pages = await Promise.all(Array.from({ length: document.numPages }, async (_, i) => {
        const viewport = (await document.getPage(i + 1)).getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height }
      }))
      if (cancelled) return
      setSizes(pages)
      setPdf(document)
    }).catch(() => { if (!cancelled) failed.current() })
    return () => {
      cancelled = true
      void opened?.destroy()
    }
  }, [bytes])

  if (!pdf) return <div className="size-6 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
  return (
    <div className="flex size-full flex-col items-center gap-3 overflow-y-auto rounded-2xl bg-kumo-recessed p-3" role="document" aria-label={title}>
      {sizes.map((size, i) => (
        <PdfSheet key={i} pdf={pdf} index={i + 1} aspect={size.width / size.height} />
      ))}
    </div>
  )
}

function PdfSheet({ pdf, index, aspect }: { pdf: PDFDocumentProxy; index: number; aspect: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let width = 0
    let cancelled = false
    const draw = () => {
      const next = Math.round(canvas.getBoundingClientRect().width)
      if (!next || next === width) return
      width = next
      drawPdfPage(pdf, index, canvas, next).then(() => { if (!cancelled) setDrawn(true) }, () => {})
    }
    const seen = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) draw()
    }, { rootMargin: '600px 0px' })
    const resized = new ResizeObserver(() => { if (width) draw() })
    seen.observe(canvas)
    resized.observe(canvas)
    return () => {
      cancelled = true
      seen.disconnect()
      resized.disconnect()
    }
  }, [pdf, index])

  return (
    <canvas
      ref={canvasRef}
      aria-label={`Page ${index}`}
      style={{ aspectRatio: aspect }}
      className={`w-full max-w-[880px] shrink-0 rounded-lg bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] ring-1 ring-black/5 transition-opacity duration-300 ${drawn ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}
