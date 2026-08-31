import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { collectManagedModels, managedModelMatches } from './managedAiProviders'

const vendor: GatekeeperVendorInfo = {
  id: 'codex',
  description: {
    displayName: 'Managed Codex',
    url: 'https://example.com',
    managedAiModels: [{
      id: 'codex-balanced',
      displayName: 'Codex Balanced',
      command: 'codex-balanced',
      description: 'Run one balanced task.',
    }],
  },
  supportedResources: [],
}

describe('managed AI provider discovery', () => {
  it('shows advertised models before connection and marks a valid account ready', () => {
    expect(collectManagedModels([vendor], [])).toMatchObject([{
      vendorId: 'codex', connected: false, credentialsValid: false,
    }])
    const ready = collectManagedModels([vendor], [
      { vendorId: 'codex', credentialsValid: false },
      { vendorId: 'codex', credentialsValid: true },
    ])
    expect(ready).toMatchObject([{
      model: { command: 'codex-balanced' }, connected: true, credentialsValid: true,
    }])
  })

  it('drops unavailable vendors and malformed command metadata', () => {
    expect(collectManagedModels([{ ...vendor, unavailable: true }], [])).toEqual([])
    const malformed = {
      ...vendor,
      description: {
        ...vendor.description,
        managedAiModels: [{
          id: 'unsafe', displayName: 'Unsafe', command: '/bad command', description: 'Bad.',
        }],
      },
    } as GatekeeperVendorInfo
    expect(collectManagedModels([malformed], [])).toEqual([])
  })

  it('searches model, command, identifier, and vendor labels', () => {
    const [entry] = collectManagedModels([vendor], [])
    expect(managedModelMatches(entry, 'balanced')).toBe(true)
    expect(managedModelMatches(entry, 'managed codex')).toBe(true)
    expect(managedModelMatches(entry, 'unrelated')).toBe(false)
  })
})
