export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

function makeFilename(title: string, fallback: string): string {
  return title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function makeBlueprintFilename(title: string, version: number): string {
  return `${makeFilename(title, 'blueprint')}-v${version}${BLUEPRINT_ARCHIVE_EXTENSION}`
}

export function makeExportFilename(title: string, extension: string): string {
  return `${makeFilename(title, 'gadget')}${extension}`
}

type SaveFileHandle = {
  createWritable(): Promise<WritableStream<Uint8Array>>
}

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}) => Promise<SaveFileHandle>

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)

  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 100)
  }
}

export async function saveStreamToFile(
  createStream: () => Promise<ReadableStream<Uint8Array>>,
  filename: string,
  fileType: {
    description: string
    contentType: string
    extension: string
  },
): Promise<void> {
  const showSaveFilePicker = (window as Window & {
    showSaveFilePicker?: SaveFilePicker
  }).showSaveFilePicker

  if (showSaveFilePicker) {
    // Open the file picker immediately after user interaction and before fetching file stream
    // to avoid browser security errors raised when delay is too long.
    let handle: SaveFileHandle
    try {
      handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: fileType.description,
          accept: {
            [fileType.contentType]: [fileType.extension],
          },
        }],
      })
    } catch (error) {
      // AbortError means the user exited the file picker without selecting a destination.
      if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
      return
    }

    const writable = await handle.createWritable()
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await createStream()
    } catch (error) {
      await writable.abort(error).catch(() => {})
      throw error
    }
    await stream.pipeTo(writable)
    return
  }

  const stream = await createStream()
  triggerBlobDownload(await new Response(stream, {
    headers: { 'Content-Type': fileType.contentType },
  }).blob(), filename)
}

export function saveTextToFile(filename: string, content: string): void {
  triggerBlobDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename)
}
