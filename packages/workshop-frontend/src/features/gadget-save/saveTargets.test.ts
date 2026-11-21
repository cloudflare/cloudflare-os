import { describe, expect, it } from 'vitest'
import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { findSaveTargets } from './saveTargets'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const format = (id: string, contentType: string, mode: 'server' | 'browser' = 'server')
  : GadgetExportFormat => ({ id, label: id, mode, contentType, fileExtension: `.${id}` })

const vendor = (resources: Partial<SupportedResource>[], unavailable?: boolean) => ({
  id: 'office',
  unavailable,
  supportedResources: resources.map(resource =>
    ({ urlPattern: `https://office.example/${resource.id}/*`, creationConfigurator: true, ...resource })),
}) as GatekeeperVendorInfo

const saved = (vendors: GatekeeperVendorInfo[], formats: GadgetExportFormat[]) =>
  findSaveTargets(vendors, formats).map(target => [target.resource.id, target.format.id])

describe('findSaveTargets', () => {
  it('offers only the types that can be saved from one of the gadget\'s exports', () => {
    const vendors = [vendor([
      { id: 'document', savableFrom: [DOCX, 'text/html'] },
      { id: 'sheet', savableFrom: ['text/csv'] },
      { id: 'folder' },
    ])]
    expect(saved(vendors, [format('html', 'text/html'), format('pdf', 'application/pdf')]))
      .toEqual([['document', 'html']])
    expect(saved(vendors, [format('pdf', 'application/pdf')])).toEqual([])
  })

  it('saves from the format the type lists first, whatever the gadget\'s order', () => {
    const vendors = [vendor([{ id: 'document', savableFrom: [DOCX, 'text/html'] }])]
    expect(saved(vendors, [format('html', 'text/html'), format('docx', DOCX)]))
      .toEqual([['document', 'docx']])
  })

  it('offers nothing for a type without a configurator or a vendor that is unavailable', () => {
    const resource = { id: 'document', savableFrom: ['text/html'] }
    const formats = [format('html', 'text/html')]
    expect(saved([vendor([{ ...resource, creationConfigurator: false }])], formats)).toEqual([])
    expect(saved([vendor([resource], true)], formats)).toEqual([])
  })
})
