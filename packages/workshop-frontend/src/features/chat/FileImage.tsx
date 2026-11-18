import { useEffect, useEffectEvent, useState } from 'react'
import { useObjectUrl } from './attachments/useObjectUrl'
import { isSvgImage } from './inlineImages'
import type { FileSnapshots } from './inlineFiles'

/** An immutable image in Markdown, resolved by the host while it streamed the answer. */
export const FileImage = ({ oid, alt = '', title, readBlob }: {
  oid: string | null | undefined
  alt?: string
  title?: string
  readBlob: FileSnapshots['readBlob']
}) => {
  const [state, setState] = useState<{ oid: string; bytes: Uint8Array; mimeType: string } | { error: string }>()
  const read = useEffectEvent(async (oid: string, signal: AbortSignal) => {
    if (state && 'bytes' in state && state.oid === oid) return
    setState(undefined)
    const stream = await readBlob(oid)
    if (signal.aborted) { await stream.cancel(); return }
    const bytes = new Uint8Array(await new Response(stream.pipeThrough(new TransformStream(), { signal })).arrayBuffer())
    const head = new TextDecoder().decode(bytes.subarray(0, 1024))
    return { oid, bytes, mimeType: isSvgImage(head) ? 'image/svg+xml' : '' }
  })
  useEffect(() => {
    if (!oid) return
    const controller = new AbortController()
    read(oid, controller.signal).then(image => {
      if (image && !controller.signal.aborted) setState(image)
    }, error => {
      if (!controller.signal.aborted) setState({ error: String(error?.message ?? error) })
    })
    return () => controller.abort()
  }, [oid, readBlob])

  const image = state && 'bytes' in state && state.oid === oid ? state : undefined
  // SVGs reuse attachment previews' originless URLs, safe when opened separately as well.
  const url = useObjectUrl(image?.bytes, image?.mimeType ?? '')
  const error = !oid || state && 'error' in state
  return image && url && !error ? <img
    src={url} data-blob-oid={oid} alt={alt} title={title} className="max-w-full h-auto"
    onError={() => setState({ error: 'This image could not be decoded.' })}
  /> : <span role="img" aria-label={alt || 'Image'} aria-busy={!error}
    title={state && 'error' in state ? state.error : title} className="text-kumo-subtle">
    {error ? `Image unavailable${alt ? `: ${alt}` : ''}` : alt || 'Loading image…'}
  </span>
}
