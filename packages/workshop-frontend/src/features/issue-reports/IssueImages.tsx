import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Loader } from '@cloudflare/kumo'
import type { IssueReportImage } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

// What became of one image: the object URL its bytes are shown through, or that they could not be
// read.
type Shown = { url: string } | { failed: true }

/**
 * The images of one issue report, read one at a time once the component mounts. An image's bytes
 * are shown through an object URL in an `<img>`, typed as the format the server recognised, and
 * nowhere else: nothing navigates to them or offers them under another type, so a browser can
 * only render them as an image.
 *
 * When the component unmounts it revokes every URL it made and cancels the read still in flight,
 * which stops the server streaming an image nobody is looking at. Whoever renders it keys it by
 * the report, so that happens when the report shown changes too.
 */
export const IssueImages = ({ images, read }: {
  images: IssueReportImage[]
  /** Reads the bytes of one of the report's images, by its id. */
  read: (imageId: string) => Promise<ReadableStream<Uint8Array>>
}) => {
  const [shown, setShown] = useState<Record<string, Shown>>({})
  const urls = useRef<string[]>([])
  const next = images.find((image) => !(image.id in shown))
  const nextId = next?.id
  const nextType = next?.type
  const readImage = useEffectEvent(read)

  useEffect(() => {
    if (nextId === undefined) return
    let cancelled = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    void (async () => {
      let result: Shown
      try {
        const stream = await readImage(nextId)
        if (cancelled) {
          void stream.cancel().catch(() => {})
          return
        }
        reader = stream.getReader()
        const chunks: BlobPart[] = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // The cast is for the DOM types, which take a chunk only when its buffer is known not to
          // be shared; a stream's chunk is not typed that way.
          chunks.push(value as BlobPart)
        }
        // A cancelled read ends as a finished one does, with what had arrived: no URL is made of it.
        if (cancelled) return
        const url = URL.createObjectURL(new Blob(chunks, { type: nextType }))
        urls.current.push(url)
        result = { url }
      } catch (err) {
        if (cancelled) return
        logRpcFailure('Failed to read an issue report’s image:', err)
        result = { failed: true }
      }
      setShown((previous) => ({ ...previous, [nextId]: result }))
    })()
    return () => {
      cancelled = true
      void reader?.cancel().catch(() => {})
    }
  }, [nextId, nextType])

  useEffect(() => {
    const made = urls.current
    return () => {
      for (const url of made) URL.revokeObjectURL(url)
      made.length = 0
    }
  }, [])

  if (images.length === 0) return null
  return (
    <ul aria-label="Images" className="flex flex-col gap-3">
      {images.map((image, index) => {
        const name = `Image ${index + 1} of ${images.length}`
        const state = shown[image.id]
        return (
          <li key={image.id}>
            {state === undefined ? (
              <Loader aria-label={`Loading ${name.toLowerCase()}`} />
            ) : 'url' in state ? (
              <img
                src={state.url}
                alt={`${name} sent with this report`}
                className="max-h-[32rem] max-w-full rounded-lg border border-kumo-line"
              />
            ) : (
              <p role="alert" className="text-sm text-kumo-danger">Couldn’t load {name.toLowerCase()}.</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
