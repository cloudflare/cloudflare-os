import { saveBytes } from './saveBytes'

/** What a file saved to the device is, for the browser's save window: "PDF", `application/pdf`, `.pdf`. */
export type SavedType = { description: string; contentType: string; extension: string }

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>

/**
 * Saves what `open` streams to the user's device under `name`, ported from `workshop-frontend`'s
 * `saveStreamToFile`. Where the browser has a save window (`showSaveFilePicker`) it is asked first,
 * as it must be while the click that asked for it is still recent, and the stream is written to
 * the file chosen as it comes; closing the window saves nothing, and is not a failure. Elsewhere it
 * is read whole and downloaded, as bytes and nothing else (`saveBytes`).
 */
export const saveStream = async (open: () => Promise<ReadableStream<Uint8Array>>, name: string, type: SavedType) => {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (!picker) {
    saveBytes(new Uint8Array(await new Response(await open()).arrayBuffer()), name)
    return
  }
  let handle
  try {
    handle = await picker({ suggestedName: name, types: [{ description: type.description, accept: { [type.contentType]: [type.extension] } }] })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    throw error
  }
  const writable = await handle.createWritable()
  let stream
  try {
    stream = await open()
  } catch (error) {
    await writable.abort(error).catch(() => {})
    throw error
  }
  await stream.pipeTo(writable)
}
