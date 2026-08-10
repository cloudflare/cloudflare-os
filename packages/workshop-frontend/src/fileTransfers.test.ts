// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeExportFilename, saveStreamToFile } from './fileTransfers'

afterEach(() => {
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
})

describe('export file transfers', () => {
  it('builds a safe filename with the advertised extension', () => {
    expect(makeExportFilename('Quarterly report / 2026', '.csv'))
      .toBe('Quarterly-report-2026.csv')
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
