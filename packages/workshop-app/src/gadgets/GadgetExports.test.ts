import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetExportFormat } from '@gadgets/workshop-shared/api'
import { GadgetExports, savedFileOf, type ExportsGadget, type ExportsOverseer } from './GadgetExports'

const pdf: GadgetExportFormat = { id: 'pdf', label: 'PDF', mode: 'browser', contentType: 'application/pdf', fileExtension: '.pdf' }

const streamOf = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text))
    controller.close()
  },
})

const fake = (gadget: Partial<ExportsGadget>) => {
  const disposed = { gadget: 0, overseer: 0 }
  const open = vi.fn<() => ExportsOverseer>(() => ({
    getGadget: () => ({
      getExportFormats: async () => [pdf],
      export: async () => streamOf('%PDF'),
      ...gadget,
      [Symbol.dispose]: () => void disposed.gadget++,
    }) as ExportsGadget,
    [Symbol.dispose]: () => void disposed.overseer++,
  }))
  return { open, disposed }
}

// A browser that asks where to save, and writes what was saved here.
const picking = (choice: 'save' | 'cancel' = 'save') => {
  const written: string[] = []
  const picker = vi.fn<(options: { suggestedName?: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>>(async () => {
    if (choice === 'cancel') throw new DOMException('Cancelled', 'AbortError')
    return {
      createWritable: async () => new WritableStream<Uint8Array>({ write: (chunk) => void written.push(new TextDecoder().decode(chunk)) }),
    }
  })
  vi.stubGlobal('window', { showSaveFilePicker: picker })
  return { picker, written }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GadgetExports', () => {
  it('reads what it can be saved as when asked, from the chat it is shown from', async () => {
    const getExportFormats = vi.fn<ExportsGadget['getExportFormats']>(async () => [pdf])
    const { open, disposed } = fake({ getExportFormats })
    const exports = new GadgetExports(open, 3, 7)
    expect(exports.getSnapshot().formats).toEqual({ status: 'unread' })

    const read = exports.loadFormats()
    expect(exports.getSnapshot().formats).toEqual({ status: 'loading' })
    await read
    expect(exports.getSnapshot().formats).toEqual({ status: 'ready', formats: [pdf] })
    expect(getExportFormats).toHaveBeenCalledWith(7)
    expect(disposed).toEqual({ gadget: 1, overseer: 1 })
  })

  it('says why its formats could not be read, and shows only the latest read', async () => {
    let fail = true
    const exports = new GadgetExports(fake({
      getExportFormats: async () => {
        if (fail) throw new Error('It has no code yet.')
        return [pdf]
      },
    }).open, 3)
    await exports.loadFormats()
    expect(exports.getSnapshot().formats).toEqual({ status: 'failed', message: 'It has no code yet.' })

    fail = false
    const first = exports.loadFormats()
    const second = exports.loadFormats()
    await Promise.all([first, second])
    expect(exports.getSnapshot().formats).toEqual({ status: 'ready', formats: [pdf] })
  })

  it('saves it where the user chooses, named for the gadget, saying so while it does', async () => {
    const { picker, written } = picking()
    const exportFn = vi.fn<ExportsGadget['export']>(async () => streamOf('%PDF'))
    const { open, disposed } = fake({ export: exportFn })
    const exports = new GadgetExports(open, 3, 7)

    const saving = exports.exportAs(pdf, 'Tip Jar')
    expect(exports.getSnapshot().progress).toEqual({ status: 'exporting', label: 'PDF' })
    await saving

    expect(picker.mock.calls[0][0]).toMatchObject({ suggestedName: 'Tip-Jar.pdf' })
    expect(exportFn).toHaveBeenCalledWith('pdf', 7)
    expect(written.join('')).toBe('%PDF')
    expect(exports.getSnapshot().progress).toBeUndefined()
    expect(disposed).toEqual({ gadget: 1, overseer: 1 })
  })

  it('asks the gadget for nothing when the user chooses nowhere', async () => {
    picking('cancel')
    const { open } = fake({})
    const exports = new GadgetExports(open, 3)
    await exports.exportAs(pdf, 'Tip Jar')
    expect(open).not.toHaveBeenCalled()
    expect(exports.getSnapshot().progress).toBeUndefined()
  })

  it('says why an export failed until it is put away', async () => {
    picking()
    const exports = new GadgetExports(fake({ export: async () => { throw new Error('Browser rendering is off.') } }).open, 3)
    await exports.exportAs(pdf, 'Tip Jar')
    expect(exports.getSnapshot().progress).toEqual({ status: 'failed', label: 'PDF', message: 'Browser rendering is off.' })

    exports.dismiss()
    expect(exports.getSnapshot().progress).toBeUndefined()
  })
})

describe('savedFileOf', () => {
  it('names the file for the gadget, unless the gadget names it', () => {
    expect(savedFileOf(pdf, 'Q3 forecast: draft').name).toBe('Q3-forecast-draft.pdf')
    expect(savedFileOf(pdf, '  ').name).toBe('gadget.pdf')
    expect(savedFileOf({ ...pdf, fileName: 'report.pdf' }, 'Tip Jar').name).toBe('report.pdf')
  })
})
