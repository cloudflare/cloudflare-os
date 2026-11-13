import { useEffect, useState } from 'react'
import { isRasterImage } from '@/files/rasterImage'
import { isSvgImage, svgDataUrl } from '@/files/svgImage'
import { useObjectUrl } from './useObjectUrl'

/**
 * An address `content` is shown from as an image, for an `<img>` only: an object URL for pixels,
 * a `data:` URL for an SVG, which has no origin (`svgImage.ts`), and nothing for anything else, or
 * no content.
 */
export const useImageUrl = (content: Blob | Uint8Array | undefined, file: { name: string; type: string }) => {
  const raster = isRasterImage(file.type)
  const pixels = useObjectUrl(raster ? content : undefined, file.type)
  const drawing = useSvgUrl(!raster && isSvgImage(file) ? content : undefined)
  return pixels ?? drawing
}

const useSvgUrl = (content: Blob | Uint8Array | undefined) => {
  const [made, setMade] = useState<{ content: Blob | Uint8Array; url: string }>()
  useEffect(() => {
    if (!content) return
    let cancelled = false
    const bytes = content instanceof Uint8Array ? Promise.resolve(content) : content.arrayBuffer().then((buffer) => new Uint8Array(buffer))
    void bytes.then((read) => {
      if (!cancelled) setMade({ content, url: svgDataUrl(read) })
    })
    return () => {
      cancelled = true
    }
  }, [content])
  return made && made.content === content ? made.url : undefined
}
