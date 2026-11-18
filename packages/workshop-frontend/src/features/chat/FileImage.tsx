import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import { useObjectUrl } from './attachments/useObjectUrl'
import { isSvgImage } from './inlineImages'
import type { FileSnapshots } from './inlineFiles'

/** The chat's existing scroll owner, notified once image dimensions are known. */
export type FileImageLayout = {
  scrollRoot: RefObject<HTMLElement | null>
  onHeightChange: () => void
}

/** An immutable image in Markdown, resolved by the host while it streamed the answer. */
export const FileImage = ({ oid, alt = '', title, readBlob, layout }: {
  oid: string | null | undefined
  alt?: string
  title?: string
  readBlob: FileSnapshots['readBlob']
  layout?: FileImageLayout
}) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [state, setState] = useState<{ oid: string; bytes: Uint8Array; mimeType: string } | { error: string }>()
  const read = useEffectEvent(async (oid: string, signal: AbortSignal) => {
    if (state && 'bytes' in state && state.oid === oid) return
    setState(undefined)
    const stream = await readBlob(oid)
    if (signal.aborted) { await stream.cancel(); return }
    const bytes = new Uint8Array(await new Response(stream.pipeThrough(new TransformStream(), { signal })).arrayBuffer())
    return { oid, bytes, mimeType: isSvgImage(bytes.subarray(0, 1024)) ? 'image/svg+xml' : '' }
  })
  const scrollRoot = layout?.scrollRoot
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      setNearViewport(true)
    }, { root: scrollRoot?.current, rootMargin: '200px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRoot])
  useEffect(() => {
    if (!oid || !nearViewport) return
    const controller = new AbortController()
    read(oid, controller.signal).then(image => {
      if (image && !controller.signal.aborted) setState(image)
    }, error => {
      if (!controller.signal.aborted) setState({ error: String(error?.message ?? error) })
    })
    return () => controller.abort()
  }, [oid, readBlob, nearViewport])

  const image = state && 'bytes' in state && state.oid === oid ? state : undefined
  // SVGs reuse attachment previews' originless URLs, safe when opened separately as well.
  const url = useObjectUrl(image?.bytes, image?.mimeType ?? '')
  const error = !oid || state && 'error' in state
  return <span ref={ref}>{image && url && !error ? <img
    src={url} data-blob-oid={oid} alt={alt} title={title} className="max-w-full h-auto"
    onLoad={layout?.onHeightChange}
    onError={() => setState({ error: 'This image could not be decoded.' })}
  /> : <span role="img" aria-label={alt || 'Image'} aria-busy={!error}
    title={state && 'error' in state ? state.error : title} className="text-kumo-subtle">
    {error ? `Image unavailable${alt ? `: ${alt}` : ''}` : alt || 'Loading image…'}
  </span>}</span>
}
