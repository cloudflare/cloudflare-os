import { useEffect, useRef, useState } from 'react'
import { MAX_ISSUE_REPORT_IMAGES } from '@gadgets/workshop-shared/api'
import { prepareReportImage } from './reportImage'

/** An image attached to a report that is being written. */
export type ReportImage = {
  id: string
  /** What the image is called where it is shown and where its upload is reported. */
  name: string
  /** The bytes that are sent: the file, or its re-encoding when the file was over the bound. */
  blob: Blob
  /** An object URL of `blob`, for the preview. */
  previewUrl: string
}

const TOO_MANY = `A report takes at most ${MAX_ISSUE_REPORT_IMAGES} images.`

// Images pasted from the clipboard all carry one name. A name that is taken gets a number, so
// that a preview's Remove button and a failed upload each name one image.
const distinctName = (name: string, taken: ReportImage[]): string => {
  const names = new Set(taken.map((image) => image.name))
  let distinct = name
  for (let number = 2; names.has(distinct); number++) distinct = `${name} (${number})`
  return distinct
}

/**
 * The images of a report that is being written: MAX_ISSUE_REPORT_IMAGES at most, each under a
 * name of its own and with an object URL for its preview, revoked when the image is removed and
 * when the owner unmounts. `problems` says what the last addition refused, and why. `adding` is
 * true while an addition is still being prepared (an image over the size bound is re-encoded):
 * `images` does not hold it yet.
 */
export const useReportImages = () => {
  const [images, setImages] = useState<ReportImage[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [additions, setAdditions] = useState(0)
  // What `images` will hold once rendered, for additions that finish between two renders.
  const held = useRef<ReportImage[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const image of held.current) URL.revokeObjectURL(image.previewUrl)
      held.current = []
    }
  }, [])

  /** Adds what fits and is an image a report takes, and resolves with how many were added. */
  const add = async (candidates: { blob: Blob; name: string }[]): Promise<number> => {
    const refused: string[] = []
    const before = held.current.length
    const room = MAX_ISSUE_REPORT_IMAGES - held.current.length
    if (candidates.length > room) refused.push(TOO_MANY)
    setAdditions((count) => count + 1)
    const prepared = await Promise.allSettled(
      candidates.slice(0, Math.max(room, 0)).map(async ({ blob, name }) => ({
        name,
        blob: await prepareReportImage(blob),
      })),
    )
    if (!mounted.current) return 0
    setAdditions((count) => count - 1)
    for (const [index, result] of prepared.entries()) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason
        const why = reason instanceof Error ? reason.message : 'This image could not be read.'
        refused.push(`${candidates[index].name}: ${why}`)
        continue
      }
      // Another addition can have taken the room while this one was prepared.
      if (held.current.length >= MAX_ISSUE_REPORT_IMAGES) {
        if (!refused.includes(TOO_MANY)) refused.push(TOO_MANY)
        break
      }
      held.current = [...held.current, {
        id: crypto.randomUUID(),
        name: distinctName(result.value.name, held.current),
        blob: result.value.blob,
        previewUrl: URL.createObjectURL(result.value.blob),
      }]
    }
    setImages(held.current)
    setProblems(refused)
    return held.current.length - before
  }

  const remove = (id: string) => {
    const image = held.current.find((candidate) => candidate.id === id)
    if (image === undefined) return
    URL.revokeObjectURL(image.previewUrl)
    held.current = held.current.filter((candidate) => candidate !== image)
    setImages(held.current)
  }

  return {
    images,
    problems,
    adding: additions > 0,
    add,
    remove,
    full: images.length >= MAX_ISSUE_REPORT_IMAGES,
  }
}
