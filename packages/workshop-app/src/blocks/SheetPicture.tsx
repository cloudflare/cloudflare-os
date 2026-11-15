import { useEffect, useRef, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'

// Pictures this page has decoded, which the browser then draws at once: a sheet drawn again (its
// page left and come back to, or laid out afresh as the window narrows) shows one straight away.
const decoded = new Set<string>()

export type SheetPictureProps = {
  /** The screen to draw, once there is one. */
  picture?: string
  /**
   * A picture that arrives now fades in, as when it comes after its card is in view; otherwise it
   * is simply there, as when what it is in is still to be shown, or the picture was on screen
   * before.
   */
  fade?: boolean
  /** The picture is ready to draw. */
  onLoad?: () => void
}

/**
 * What fills a sheet of paper in a card (`SHEET`): a screen, drawn only once it is decoded, so it
 * never draws in piece by piece, and a blank page until then. A newer picture takes the place of
 * the one shown only once it is ready too, so the sheet never goes blank in between.
 */
export const SheetPicture = ({ picture, fade = true, onLoad }: SheetPictureProps) => {
  const [shown, setShown] = useState<{ src: string; fade: boolean } | undefined>(() =>
    picture !== undefined && decoded.has(picture) ? { src: picture, fade: false } : undefined)
  const fadeRef = useRef(fade)
  useEffect(() => {
    fadeRef.current = fade
  })
  const onLoadRef = useRef(onLoad)
  useEffect(() => {
    onLoadRef.current = onLoad
  })

  const showing = shown?.src
  useEffect(() => {
    if (picture === undefined || picture === showing) return
    let cancelled = false
    const image = new Image()
    image.src = picture
    image.decode().then(() => {
      decoded.add(picture)
      // Only the first picture fades in; a newer one replaces it as it is.
      if (!cancelled) setShown((before) => ({ src: picture, fade: before === undefined && fadeRef.current }))
    }, () => {})
    return () => {
      cancelled = true
    }
  }, [picture, showing])

  useEffect(() => {
    if (showing !== undefined) onLoadRef.current?.()
  }, [showing])

  if (!shown) return null
  return (
    <img
      key={shown.src}
      src={shown.src}
      alt=""
      className={cn('size-full object-cover object-top', shown.fade && 'picture-appears')}
    />
  )
}
