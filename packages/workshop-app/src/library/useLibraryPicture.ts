import { createElement, useEffect, useRef, useState } from 'react'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { useFileThumbnail, type FileThumbnail } from '@/blocks/file-preview/useFileThumbnail'
import { scrollRoot } from '@/blocks/file-preview/scrollRoot'
import { ConnectedFileThumbnail } from '@/blocks/resource-preview/ConnectedFileThumbnail'
import { previewFormat } from '@/files/previewFormat'
import { useObjectUrl } from '@/hooks/useObjectUrl'
import { useApi } from '@/rpc/ApiContext'
import type { LibraryEntry } from './libraryEntries'

// Pictures the browser draws as they are, and nothing that could run: never an SVG.
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
// A larger one is shown by its glyph, rather than fetched whole to be drawn small.
const LARGEST = 4 * 1024 * 1024
// What was fetched is kept for this many, so that switching between the list and the grid, or tabs,
// does not fetch them again.
const KEPT = 80
// Gadgets' pictures asked for at once: each may take a browser of the server's to draw.
const AT_ONCE = 2
// A gadget the server could not draw yet, as when its browser was starting, is asked for again
// after this long, this many times while its tile is shown.
const RETRY_AFTER = 8000
const RETRIES = 2

/** What has been fetched for the Library's tiles, by what it is of, kept for `KEPT` of them. */
class Kept<T> {
  #fetched = new Map<string, Promise<T>>()

  get(key: string, fetch: () => Promise<T>): Promise<T> {
    const known = this.#fetched.get(key)
    if (known) return known
    const fetching = fetch()
    this.#fetched.set(key, fetching)
    if (this.#fetched.size > KEPT) this.#fetched.delete(this.#fetched.keys().next().value!)
    // One that failed is asked for again next time.
    fetching.catch(() => this.#fetched.delete(key))
    return fetching
  }

  /** Lets go of what was fetched for `key`, so it is fetched again next time. */
  forget(key: string) {
    this.#fetched.delete(key)
  }
}

const files = new Kept<Uint8Array>()
const gadgets = new Kept<Uint8Array | null>()
const connected = new Kept<ResourcePreview | null>()

// Gadgets' pictures, a few at a time, in the order their tiles came near the screen.
let drawing = 0
const waiting: Array<() => void> = []
const inTurn = async <T,>(fetch: () => Promise<T>): Promise<T> => {
  if (drawing >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve))
  drawing++
  try {
    return await fetch()
  } finally {
    drawing--
    waiting.shift()?.()
  }
}

/** Calls `onNear` once `ref`'s element comes within a screen's reach, while `wanted`. */
const useNearScreen = (ref: { current: Element | null }, wanted: boolean, onNear: () => () => void) => {
  const onNearRef = useRef(onNear)
  useEffect(() => {
    onNearRef.current = onNear
  })
  useEffect(() => {
    const element = ref.current
    if (!element || !wanted) return
    let stop: (() => void) | undefined
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      stop = onNearRef.current()
    }, { root: scrollRoot(element), rootMargin: '200px' })
    observer.observe(element)
    return () => {
      observer.disconnect()
      stop?.()
    }
  }, [ref, wanted])
}

type Api = ReturnType<typeof useApi>['api']

/** Calls into a workspace, letting go of it after. */
const inWorkspace = async <T,>(api: Api, workspaceId: string, call: (overseer: ReturnType<Api['openWorkspace']>) => Promise<T>) => {
  const overseer = api.openWorkspace(workspaceId)
  try {
    return await call(overseer)
  } finally {
    overseer[Symbol.dispose]()
  }
}

/**
 * What a Library entry shows of itself: an image file's own picture (`photo`), fetched at once
 * when it is one the browser draws and not too large; or once its tile nears the screen, a glimpse
 * of it (`preview`): a gadget's screen as the server draws it (`GadgetClient.getThumbnail`), a
 * file's first page, slide or sheet as the chat draws it, a Google file's top as its own view
 * draws it. Nothing for anything else, or until it arrives. `ref` is the tile.
 */
export const useLibraryPicture = (entry: LibraryEntry) => {
  const { api, reconnecting } = useApi()
  const { item } = entry
  const file = item.kind === 'file' && item.file.chatId !== undefined ? item.file : undefined
  const photo = file && PICTURES.has(file.mimeType) && file.size > 0 && file.size <= LARGEST ? file : undefined
  const fileKey = file && `${file.workspaceId}/${file.chatId}/${file.id}`
  const loadFile = file && !reconnecting
    ? () => files.get(fileKey!, () => inWorkspace(api, file.workspaceId, (overseer) => overseer.getChatAttachmentContent(file.chatId!, file.id)))
    : undefined
  const { ref, thumbnail: fileThumbnail } = useFileThumbnail<HTMLDivElement>(
    file && !photo ? previewFormat({ name: file.name, type: file.mimeType }) : undefined,
    loadFile,
  )

  // The photo, fetched with the entry rather than once near the screen, as a row shows it too.
  const [photoBytes, setPhotoBytes] = useState<{ key: string; bytes: Uint8Array }>()
  const photoKey = photo && fileKey
  const photoWorkspace = photo?.workspaceId
  const photoChat = photo?.chatId
  const photoId = photo?.id
  useEffect(() => {
    if (!photoKey || reconnecting || photoWorkspace === undefined || photoChat === undefined || photoId === undefined) return
    let cancelled = false
    files.get(photoKey, () => inWorkspace(api, photoWorkspace, (overseer) => overseer.getChatAttachmentContent(photoChat, photoId)))
      .then((bytes) => !cancelled && setPhotoBytes({ key: photoKey, bytes }), () => {})
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, photoKey, photoWorkspace, photoChat, photoId])

  // A gadget's screen, drawn again by the server only when its code changed; asked for again
  // here when the gadget was worked on since.
  const output = item.kind === 'output' && item.output.type === 'gadget' ? item.output : undefined
  const gadgetKey = output && `${output.workspaceId}/${output.workpieceId}/${entry.at.valueOf()}`
  const [gadgetBytes, setGadgetBytes] = useState<{ key: string; bytes: Uint8Array }>()
  // A Google file's top, read through the connection its workspace reaches it by.
  const linked = item.kind === 'connected' ? item.connected : undefined
  const linkedKey = linked && `${linked.workspaceId}/${linked.gatekeeperId}/${linked.subjectId}`
  const [linkedPreview, setLinkedPreview] = useState<{ key: string; preview: ResourcePreview }>()

  useNearScreen(ref, !reconnecting && (gadgetKey !== undefined || linkedKey !== undefined), () => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    if (output && gadgetKey) {
      // None is not kept: the server may draw it a little later, and another tile asks again.
      const draw = (tries: number) => gadgets.get(gadgetKey, () => inTurn(() => inWorkspace(api, output.workspaceId,
        (overseer) => overseer.getGadget(output.workpieceId).getThumbnail())))
        .then((bytes) => {
          if (bytes) {
            if (!cancelled) setGadgetBytes({ key: gadgetKey, bytes })
            return
          }
          gadgets.forget(gadgetKey)
          if (!cancelled && tries > 0) retry = setTimeout(() => draw(tries - 1), RETRY_AFTER)
        }, () => {})
      draw(RETRIES)
    }
    if (linked && linkedKey) {
      connected.get(linkedKey, () => inWorkspace(api, linked.workspaceId,
        (overseer) => overseer.previewResource(linked.gatekeeperId, linked.subjectId)))
        .then((preview) => !cancelled && preview && setLinkedPreview({ key: linkedKey, preview }), () => {})
    }
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  })

  const photoUrl = useObjectUrl(photoBytes?.key === photoKey ? photoBytes?.bytes : undefined, photo?.mimeType ?? '')
  const gadgetUrl = useObjectUrl(gadgetBytes?.key === gadgetKey ? gadgetBytes?.bytes : undefined, 'image/jpeg')
  const preview: FileThumbnail | null = gadgetUrl
    ? { type: 'image', url: gadgetUrl, whole: false }
    : linkedPreview && linkedPreview.key === linkedKey
      ? { type: 'view', view: createElement(ConnectedFileThumbnail, { preview: linkedPreview.preview }) }
      : fileThumbnail
  return { ref, photo: photoUrl, preview }
}
