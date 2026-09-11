export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

const ZIP_UTF8_FLAG = 0x0800
const ZIP_STORE_METHOD = 0
const ZIP_DOS_DATE = 33 // 1980-01-01
const ZIP_MAX_UINT16 = 0xffff
const ZIP_MAX_UINT32 = 0xffffffff

const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let value = i
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC32_TABLE[i] = value >>> 0
}

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

function zipRecord(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

type ZipEntry = {
  name: Uint8Array
  data: Uint8Array
  crc: number
  localOffset: number
}

function assertSafeZipPath(path: string): void {
  const segments = path.split('/')
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Cannot archive unsafe file path: ${path}`)
  }
}

export function createFilesZip(files: ReadonlyMap<string, string>): Blob {
  if (files.size > ZIP_MAX_UINT16) throw new Error('Too many files to create a ZIP archive')

  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const entries: ZipEntry[] = []
  let offset = 0
  const append = (bytes: Uint8Array) => {
    chunks.push(bytes)
    offset += bytes.byteLength
    if (offset > ZIP_MAX_UINT32) throw new Error('Files are too large to create a ZIP archive')
  }

  for (const [path, text] of [...files].toSorted(([a], [b]) => a.localeCompare(b))) {
    assertSafeZipPath(path)
    const name = encoder.encode(path)
    const data = encoder.encode(text)
    if (name.byteLength > ZIP_MAX_UINT16) throw new Error(`File path is too long: ${path}`)
    const crc = crc32(data)
    const localOffset = offset
    append(zipRecord(30, view => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, ZIP_UTF8_FLAG, true)
      view.setUint16(8, ZIP_STORE_METHOD, true)
      view.setUint16(12, ZIP_DOS_DATE, true)
      view.setUint32(14, crc, true)
      view.setUint32(18, data.byteLength, true)
      view.setUint32(22, data.byteLength, true)
      view.setUint16(26, name.byteLength, true)
    }))
    append(name)
    append(data)
    entries.push({ name, data, crc, localOffset })
  }

  const centralOffset = offset
  for (const entry of entries) {
    append(zipRecord(46, view => {
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(8, ZIP_UTF8_FLAG, true)
      view.setUint16(10, ZIP_STORE_METHOD, true)
      view.setUint16(14, ZIP_DOS_DATE, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, entry.data.byteLength, true)
      view.setUint32(24, entry.data.byteLength, true)
      view.setUint16(28, entry.name.byteLength, true)
      view.setUint32(42, entry.localOffset, true)
    }))
    append(entry.name)
  }
  const centralSize = offset - centralOffset
  append(zipRecord(22, view => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, entries.length, true)
    view.setUint16(10, entries.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, centralOffset, true)
  }))

  const archive = new Uint8Array(offset)
  let cursor = 0
  for (const chunk of chunks) {
    archive.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return new Blob([archive.buffer], { type: 'application/zip' })
}

export function saveFilesToZip(filename: string, files: ReadonlyMap<string, string>): void {
  triggerBlobDownload(createFilesZip(files), filename)
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
