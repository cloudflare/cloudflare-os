// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFilesZip, makeExportFilename, saveStreamToFile } from './fileTransfers'

afterEach(() => {
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
})

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), { once: true })
    reader.addEventListener('error', () => reject(reader.error), { once: true })
    reader.readAsArrayBuffer(blob)
  })
}

describe('export file transfers', () => {
  it('builds a safe filename with the advertised extension', () => {
    expect(makeExportFilename('Quarterly report / 2026', '.csv'))
      .toBe('Quarterly-report-2026.csv')
  })

  it('creates a ZIP containing every file and its path', async () => {
    const blob = createFilesZip(new Map([
      ['server/index.ts', 'export default {}'],
      ['client.js', 'console.log("hello")'],
    ]))
    const bytes = new Uint8Array(await readBlob(blob))
    const view = new DataView(bytes.buffer)
    const decoder = new TextDecoder()
    const files = new Map<string, string>()
    let offset = 0

    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true)
      const nameLength = view.getUint16(offset + 26, true)
      const extraLength = view.getUint16(offset + 28, true)
      const nameStart = offset + 30
      const dataStart = nameStart + nameLength + extraLength
      files.set(
        decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
        decoder.decode(bytes.subarray(dataStart, dataStart + size)),
      )
      offset = dataStart + size
    }

    expect(blob.type).toBe('application/zip')
    expect(files).toEqual(new Map([
      ['client.js', 'console.log("hello")'],
      ['server/index.ts', 'export default {}'],
    ]))
    expect(view.getUint32(bytes.byteLength - 22, true)).toBe(0x06054b50)
    expect(view.getUint16(bytes.byteLength - 12, true)).toBe(2)
  })

  it('refuses paths that could escape the archive directory', () => {
    expect(() => createFilesZip(new Map([['../outside.txt', 'nope']]))).toThrow('unsafe file path')
    expect(() => createFilesZip(new Map([['..\\outside.txt', 'nope']]))).toThrow('unsafe file path')
  })

  it('opens the picker before starting the export stream', async () => {
    const order: string[] = []
    const picker = vi.fn<(_options: unknown) => Promise<{
      createWritable(): Promise<WritableStream<Uint8Array>>
    }>>(async () => {
      order.push('picker')
      return {
        async createWritable() {
          order.push('writable')
          return new WritableStream<Uint8Array>({
            write(bytes) {
              order.push(`write:${new TextDecoder().decode(bytes)}`)
            },
            close() {
              order.push('close')
            },
          })
        },
      }
    })
    Object.assign(window, { showSaveFilePicker: picker })

    await saveStreamToFile(
      async () => {
        order.push('source')
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('value'))
            controller.close()
          },
        })
      },
      'report.csv',
      { description: 'CSV', contentType: 'text/csv', extension: '.csv' },
    )

    expect(order).toEqual(['picker', 'writable', 'source', 'write:value', 'close'])
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'report.csv',
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    })
  })

  it('does not start a lazy export when the file picker is cancelled', async () => {
    Object.assign(window, {
      showSaveFilePicker: vi.fn<() => Promise<never>>()
        .mockRejectedValue(new DOMException('Cancelled', 'AbortError')),
    })
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>()

    await expect(saveStreamToFile(
      source,
      'report.pdf',
      { description: 'PDF', contentType: 'application/pdf', extension: '.pdf' },
    )).resolves.toBeUndefined()

    expect(source).not.toHaveBeenCalled()
  })

  it('propagates file picker failures other than cancellation', async () => {
    Object.assign(window, {
      showSaveFilePicker: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('picker failed')),
    })
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>()

    await expect(saveStreamToFile(
      source,
      'report.pdf',
      { description: 'PDF', contentType: 'application/pdf', extension: '.pdf' },
    )).rejects.toThrow('picker failed')

    expect(source).not.toHaveBeenCalled()
  })

  it('preserves the advertised content type in the Blob fallback', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:test')
    const oldCreateObjectURL = URL.createObjectURL
    const oldRevokeObjectURL = URL.revokeObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
    try {
      await saveStreamToFile(
        async () => new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('a,b'))
            controller.close()
          },
        }),
        'report.csv',
        { description: 'CSV', contentType: 'text/csv', extension: '.csv' },
      )

      expect(createObjectURL.mock.calls[0]?.[0].type).toBe('text/csv')
    } finally {
      URL.createObjectURL = oldCreateObjectURL
      URL.revokeObjectURL = oldRevokeObjectURL
      click.mockRestore()
    }
  })

})
