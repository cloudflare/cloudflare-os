import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { SavedExport } from '@/prefs/savedExports'
import { exportFileName, GadgetExports, savedExportKey, saveTargetsOf, type ExportGadget, type ExportSaving, type GadgetExportsOptions } from './GadgetExports'

const PDF: GadgetExportFormat = { id: 'pdf', label: 'PDF', mode: 'browser', contentType: 'application/pdf', fileExtension: '.pdf' }
const DOCX: GadgetExportFormat = {
  id: 'docx', label: 'Word document', mode: 'server', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileExtension: '.docx',
}

const resource = (title: string, extra: Partial<SupportedResource> = {}): SupportedResource => ({
  id: title.toLowerCase(), urlPattern: `https://example.com/${title.toLowerCase()}/*`, title, description: title, ...extra,
})

const vendor = (id: string, supportedResources: SupportedResource[], unavailable?: boolean): GatekeeperVendorInfo => ({
  id, description: { displayName: id } as GatekeeperVendorInfo['description'], supportedResources, ...(unavailable ? { unavailable } : {}),
})

const DOCS = resource('Document', { creationConfigurator: true, savableFrom: [DOCX.contentType, PDF.contentType] })
const GOOGLE = vendor('google', [DOCS, resource('Sheet', { savableFrom: [PDF.contentType] }), resource('Folder', { creationConfigurator: true })])

type SaveToDevice = GadgetExportsOptions['saveToDevice']


const stream = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })

const fakeGadget = (formats: GadgetExportFormat[] | Error = [PDF, DOCX]) => {
  const gadget = {
    getExportFormats: vi.fn<ExportGadget['getExportFormats']>(async () => {
      if (formats instanceof Error) throw formats
      return formats
    }),
    export: vi.fn<ExportGadget['export']>(async () => stream()),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return gadget
}

const fakeSaving = (saved: Record<string, SavedExport> = {}) => ({
  listVendors: vi.fn<ExportSaving['listVendors']>(async () => [GOOGLE]),
  saveFile: vi.fn<ExportSaving['saveFile']>(async () => ({ url: 'https://docs.example.com/d/1' })),
  keyOf: (target) => `${target.vendor.id}:${target.resource.id}`,
  read: (key) => saved[key],
  write: vi.fn<ExportSaving['write']>((key, value) => { saved[key] = value }),
}) satisfies ExportSaving

afterEach(() => {
  vi.useRealTimers()
})

describe('exportFileName', () => {
  it('names it after the gadget, made safe, unless its format suggests a name', () => {
    expect(exportFileName('Q3 platform review', PDF)).toBe('Q3-platform-review.pdf')
    expect(exportFileName('  ✨  ', PDF)).toBe('gadget.pdf')
    expect(exportFileName('Q3 review', { ...PDF, fileName: 'Board pack.pdf' })).toBe('Board-pack.pdf')
    expect(exportFileName('Q3 review', { ...PDF, fileName: '***' })).toBe('Q3-review.pdf')
  })
})

describe('saveTargetsOf', () => {
  it('offers each kind with a form that is made from one of the formats, from the one it likes best', () => {
    expect(saveTargetsOf([GOOGLE], [PDF, DOCX])).toEqual([{ vendor: GOOGLE, resource: DOCS, format: DOCX }])
    expect(saveTargetsOf([GOOGLE], [PDF])).toEqual([{ vendor: GOOGLE, resource: DOCS, format: PDF }])
  })

  it('offers nothing of a service that could not be reached, or for formats nothing is made from', () => {
    expect(saveTargetsOf([vendor('google', [DOCS], true)], [PDF])).toEqual([])
    expect(saveTargetsOf([GOOGLE], [{ ...PDF, contentType: 'text/html' }])).toEqual([])
  })
})

describe('savedExportKey', () => {
  it('keeps a save apart by user, workspace, gadget, service and kind', () => {
    const target = { vendor: GOOGLE, resource: DOCS, format: DOCX }
    const key = savedExportKey('ada', { workspaceId: 'w1', workpieceId: 7 }, target)
    expect(savedExportKey('grace', { workspaceId: 'w1', workpieceId: 7 }, target)).not.toBe(key)
    expect(savedExportKey('ada', { workspaceId: 'w2', workpieceId: 7 }, target)).not.toBe(key)
    expect(savedExportKey('ada', { workspaceId: 'w1', workpieceId: 7 }, { ...target, format: PDF })).toBe(key)
  })
})

describe('GadgetExports', () => {
  it('lists the formats, read from the chat’s changes, and lets the gadget go again', async () => {
    const gadget = fakeGadget()
    const exports = new GadgetExports(() => gadget, { chatId: 3, saveToDevice: vi.fn<SaveToDevice>() })
    expect(exports.getSnapshot().choices).toBeUndefined()
    const listing = exports.list()
    expect(exports.getSnapshot().choices).toEqual({ status: 'loading' })
    await listing
    expect(gadget.getExportFormats).toHaveBeenCalledWith(3)
    expect(exports.getSnapshot().choices).toEqual({ status: 'ready', formats: [PDF, DOCX], saves: [] })
    expect(gadget[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('says why the formats could not be read, and reads them again when asked', async () => {
    let gadget = fakeGadget(new Error('The workspace restarted.'))
    const exports = new GadgetExports(() => gadget, { saveToDevice: vi.fn<SaveToDevice>() })
    await exports.list()
    expect(exports.getSnapshot().choices).toEqual({ status: 'failed', message: 'The workspace restarted.' })
    gadget = fakeGadget([PDF])
    await exports.list()
    expect(exports.getSnapshot().choices).toMatchObject({ status: 'ready', formats: [PDF] })
  })

  it('keeps only the latest listing', async () => {
    const slow = fakeGadget([PDF])
    let release!: () => void
    slow.getExportFormats.mockImplementation(() => new Promise((resolve) => { release = () => resolve([PDF]) }))
    const gadgets = [slow, fakeGadget([DOCX])]
    const exports = new GadgetExports(() => gadgets.shift()!, { saveToDevice: vi.fn<SaveToDevice>() })
    const first = exports.list()
    await exports.list()
    release()
    await first
    expect(exports.getSnapshot().choices).toMatchObject({ formats: [DOCX] })
  })

  it('offers saves, with what was saved before, only given the way to save', async () => {
    const saved = { 'google:document': { accountId: 2, url: 'https://docs.example.com/d/0', name: 'Q3' } }
    const exports = new GadgetExports(() => fakeGadget(), { saving: fakeSaving(saved), saveToDevice: vi.fn<SaveToDevice>() })
    await exports.list()
    expect(exports.getSnapshot().choices).toMatchObject({ saves: [{ key: 'google:document', resource: DOCS, format: DOCX, saved: saved['google:document'] }] })
  })

  it('still offers the formats when the services cannot be listed', async () => {
    const saving = fakeSaving()
    saving.listVendors.mockRejectedValue(new Error('down'))
    const exports = new GadgetExports(() => fakeGadget(), { saving, saveToDevice: vi.fn<SaveToDevice>() })
    await exports.list()
    expect(exports.getSnapshot().choices).toEqual({ status: 'ready', formats: [PDF, DOCX], saves: [] })
  })

  it('saves an export to the device under the gadget’s name, one at a time, saying so meanwhile', async () => {
    const gadget = fakeGadget()
    let finish!: () => void
    const saveToDevice = vi.fn<SaveToDevice>(async (open) => {
      await open()
      await new Promise<void>((resolve) => { finish = resolve })
    })
    const exports = new GadgetExports(() => gadget, { chatId: 3, saveToDevice })
    const download = exports.download(DOCX, 'Q3 review')
    expect(exports.getSnapshot().activity).toEqual({ kind: 'exporting', format: DOCX })
    await exports.download(PDF, 'Q3 review')
    expect(saveToDevice).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(gadget.export).toHaveBeenCalledWith('docx', 3))
    finish()
    await download
    expect(saveToDevice).toHaveBeenCalledWith(expect.any(Function), 'Q3-review.docx', { description: 'Word document', contentType: DOCX.contentType, extension: '.docx' })
    expect(exports.getSnapshot().activity).toBeUndefined()
    expect(gadget[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('says why an export to the device failed, until put away', async () => {
    const exports = new GadgetExports(() => fakeGadget(), { saveToDevice: async () => { throw new Error('No room left') } })
    await exports.download(PDF, 'Q3')
    expect(exports.getSnapshot().activity).toEqual({ kind: 'failed', format: PDF, message: 'No room left' })
    exports.dismiss()
    expect(exports.getSnapshot().activity).toBeUndefined()
  })

  it('saves to an account, passing the export on unawaited, and remembers the file for an update', async () => {
    vi.useFakeTimers()
    const gadget = fakeGadget()
    const saving = fakeSaving()
    const exports = new GadgetExports(() => gadget, { chatId: 3, saving, saveToDevice: vi.fn<SaveToDevice>() })
    await exports.list()
    const choices = exports.getSnapshot().choices
    if (choices?.status !== 'ready') throw new Error('not listed')
    await exports.save(choices.saves[0], { accountId: 2, destination: 'folder:root', name: 'Q3 review' })
    const [, typeId, destination, name, contentType, file] = saving.saveFile.mock.calls[0]
    expect([typeId, destination, name, contentType]).toEqual(['document', 'folder:root', 'Q3 review', DOCX.contentType])
    expect(file).toBe(gadget.export.mock.results[0].value)
    expect(saving.write).toHaveBeenCalledWith('google:document', { accountId: 2, url: 'https://docs.example.com/d/1', name: 'Q3 review' })
    expect(exports.getSnapshot()).toMatchObject({
      choices: { saves: [{ saved: { name: 'Q3 review' } }] },
      activity: { kind: 'saved', title: 'Saved to Document', url: 'https://docs.example.com/d/1' },
    })
    vi.advanceTimersByTime(6000)
    expect(exports.getSnapshot().activity).toBeUndefined()
  })

  it('rejects a save that failed, for the dialog to say why, and links nothing that is not a web address', async () => {
    const saving = fakeSaving()
    const exports = new GadgetExports(() => fakeGadget(), { saving, saveToDevice: vi.fn<SaveToDevice>() })
    await exports.list()
    const choices = exports.getSnapshot().choices
    if (choices?.status !== 'ready') throw new Error('not listed')
    saving.saveFile.mockRejectedValueOnce(new Error('Quota exceeded'))
    await expect(exports.save(choices.saves[0], { accountId: 2, destination: 'x', name: 'Q3' })).rejects.toThrow('Quota exceeded')
    expect(saving.write).not.toHaveBeenCalled()
    saving.saveFile.mockResolvedValueOnce({ url: 'javascript:alert(1)' })
    await exports.save(choices.saves[0], { accountId: 2, destination: 'x', name: 'Q3' })
    expect(exports.getSnapshot().activity).toEqual({ kind: 'saved', title: 'Saved to Document', url: undefined })
  })

  it('shows nothing of what comes back once stopped', async () => {
    const exports = new GadgetExports(() => fakeGadget(), { saveToDevice: vi.fn<SaveToDevice>() })
    const listing = exports.list()
    exports.stop()
    await listing
    expect(exports.getSnapshot().choices).toEqual({ status: 'loading' })
  })
})
