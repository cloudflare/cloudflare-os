import { describe, expect, it } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedAccount } from './ConnectedAccounts'
import { creationAccountOf } from './creation'

const DOC = 'https://docs.google.com/document/d/*'
const account = (id: number, change: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id,
  vendorId: 'google',
  description: { displayName: `ada${id}@example.com`, grantedResourceUrlPatterns: [DOC] },
  vendor: { displayName: 'Google' },
  supportedResources: [],
  credentialsValid: true,
  ...change,
} as ConnectedAccount)
const resources = [{ urlPattern: DOC, title: 'Document', grantable: true, creatable: true }] as unknown as SupportedResource[]
const target = { vendorId: 'google', typeUrlPattern: DOC }

describe('creationAccountOf', () => {
  it('is the only account that can create it', () => {
    expect(creationAccountOf([account(1), account(2, { vendorId: 'github' })], target, resources)).toBe(1)
  })

  it('leaves the choice to the user between two, or with none', () => {
    expect(creationAccountOf([account(1), account(2)], target, resources)).toBeUndefined()
    expect(creationAccountOf([], target, resources)).toBeUndefined()
  })

  it('passes over an account signed out, or without access to the kind', () => {
    const signedOut = account(2, { credentialsValid: false })
    const ungranted = account(3, { description: { ...account(0).description, grantedResourceUrlPatterns: [] } })
    expect(creationAccountOf([account(1), signedOut, ungranted], target, resources)).toBe(1)
    expect(creationAccountOf([ungranted], target, resources)).toBeUndefined()
  })

  it('asks when the agent suggested where, for the user to look over', () => {
    expect(creationAccountOf([account(1)], { ...target, configuration: 'https://drive.google.com/drive/folders/x' }, resources)).toBeUndefined()
  })
})
