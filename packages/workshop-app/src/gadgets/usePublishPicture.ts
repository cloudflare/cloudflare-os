import { useEffect, useRef, useState } from 'react'
import type { GadgetSettings } from './GadgetSettings'

type Drawn = { bytes: Uint8Array; url: string } | null

/**
 * The picture a gadget is published with, drawn once publishing is asked for (`open`) and kept
 * while it stays open: as the dialog shows it, and as `bytes()` gives it, to publish, waiting for
 * the drawing where it is not done. A picture that cannot be drawn is none, as a gadget with no
 * screen has.
 */
export const usePublishPicture = (settings: GadgetSettings, open: boolean) => {
  const [drawn, setDrawn] = useState<Drawn | undefined>()
  // The drawing under way, for a publish that comes before it is done.
  const drawing = useRef<Promise<Drawn>>(undefined)

  useEffect(() => {
    if (!open) return
    let current = true
    let url: string | undefined
    const started = settings.picture().then(
      (bytes): Drawn => {
        if (!bytes) return null
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
        return { bytes, url }
      },
      () => null,
    )
    drawing.current = started
    void started.then((next) => { if (current) setDrawn(next) })
    return () => {
      current = false
      drawing.current = undefined
      setDrawn(undefined)
      // Once it is drawn, if it is not yet.
      void started.then(() => { if (url) URL.revokeObjectURL(url) })
    }
  }, [settings, open])

  return {
    picture: drawn === undefined ? { status: 'drawing' as const } : drawn && { status: 'ready' as const, url: drawn.url },
    bytes: async () => (await drawing.current)?.bytes ?? null,
  }
}
