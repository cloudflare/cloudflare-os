/** What a file is saved as: its name, and its type for the browser's save dialog. */
export type SavedFile = { name: string; contentType: string; extension: string; description: string }

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>

/** Saves bytes to this device, as bytes and nothing else, so that they are saved rather than opened. */
export const saveBytes = (bytes: BlobPart | Blob, name: string) => {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Saves what `open` streams to this device. Where the browser lets the user choose where, it asks
 * first, while the click that asked for it still counts, and writes as it streams; otherwise it is
 * gathered, then downloaded. Resolves to false if the user chose nowhere, and rejects with why it
 * could not be saved.
 */
export const saveStream = async (open: () => Promise<ReadableStream<Uint8Array>>, file: SavedFile): Promise<boolean> => {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (!picker) {
    saveBytes(await new Response(await open()).blob(), file.name)
    return true
  }
  let handle: Awaited<ReturnType<SaveFilePicker>>
  try {
    handle = await picker({ suggestedName: file.name, types: [{ description: file.description, accept: { [file.contentType]: [file.extension] } }] })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false
    throw error
  }
  const writable = await handle.createWritable()
  try {
    await (await open()).pipeTo(writable)
  } catch (error) {
    // `pipeTo` aborts it itself; one never opened is aborted here, so no empty file is left.
    await writable.abort(error).catch(() => {})
    throw error
  }
  return true
}

/** A name for a file from a title: its letters and digits, the rest as dashes, or `fallback`. */
export const fileNameOf = (title: string, fallback: string) =>
  title.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || fallback
