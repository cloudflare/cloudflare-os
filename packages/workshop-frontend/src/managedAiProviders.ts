import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type {
  ManagedAiModelDescription,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'

export type ConnectedManagedAccount = {
  vendorId: string
  credentialsValid: boolean
}

export type ManagedModelEntry = {
  vendorId: string
  vendor: VendorDescription
  model: ManagedAiModelDescription
  connected: boolean
  credentialsValid: boolean
}

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_MODELS_PER_VENDOR = 24

function isManagedModel(value: unknown): value is ManagedAiModelDescription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const model = value as Record<string, unknown>
  return typeof model.id === 'string' && model.id.trim().length > 0 &&
    typeof model.displayName === 'string' && model.displayName.trim().length > 0 &&
    typeof model.command === 'string' && COMMAND_PATTERN.test(model.command) &&
    typeof model.description === 'string' && model.description.trim().length > 0
}

/**
 * Flatten bounded Gatekeeper discovery metadata into provider-page rows. The
 * RPC is typed, but this runtime check keeps malformed third-party metadata
 * from breaking the whole Providers page.
 */
export function collectManagedModels(
  vendors: GatekeeperVendorInfo[],
  connectedAccounts: Iterable<ConnectedManagedAccount>,
): ManagedModelEntry[] {
  const accounts = [...connectedAccounts]
  return vendors.flatMap((provider) => {
    if (provider.unavailable || !Array.isArray(provider.description.managedAiModels)) return []
    const providerAccounts = accounts.filter((account) => account.vendorId === provider.id)
    return provider.description.managedAiModels
      .slice(0, MAX_MODELS_PER_VENDOR)
      .filter(isManagedModel)
      .map((model) => ({
        vendorId: provider.id,
        vendor: provider.description,
        model,
        connected: providerAccounts.length > 0,
        credentialsValid: providerAccounts.some((account) => account.credentialsValid),
      }))
  })
}

export function managedModelMatches(entry: ManagedModelEntry, search: string): boolean {
  if (!search) return true
  const query = search.toLowerCase()
  return [entry.model.displayName, entry.model.id, entry.model.command, entry.vendor.displayName]
    .some((value) => value.toLowerCase().includes(query))
}
