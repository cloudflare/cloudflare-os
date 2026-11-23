import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

/** A resource type a gadget can be saved as, and the export to save it from. */
export type SaveTarget = {
  vendor: GatekeeperVendorInfo
  resource: SupportedResource
  format: GadgetExportFormat
}

/** Every type that can be saved from one of `formats`, each with the format it likes best. */
export const findSaveTargets = (
  vendors: GatekeeperVendorInfo[], formats: GadgetExportFormat[],
): SaveTarget[] =>
  vendors.flatMap(vendor => vendor.unavailable ? [] : vendor.supportedResources.flatMap(resource => {
    const format = resource.creationConfigurator
      ? resource.savableFrom
        ?.map(contentType => formats.find(candidate => candidate.contentType === contentType))
        .find(candidate => candidate)
      : undefined
    return format ? [{ vendor, resource, format }] : []
  }))
