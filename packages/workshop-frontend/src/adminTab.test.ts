import { describe, expect, it } from 'vitest'
import { resolveAdminTab } from './adminTab'

describe('resolveAdminTab', () => {
  it('shows the requested tab when it exists', () => {
    expect(resolveAdminTab('models', { updatesAvailable: false })).toBe('models')
    expect(resolveAdminTab('updates', { updatesAvailable: true })).toBe('updates')
  })

  it('shows General for no tab or an unknown one', () => {
    expect(resolveAdminTab(undefined, { updatesAvailable: true })).toBe('general')
    expect(resolveAdminTab('billing', { updatesAvailable: true })).toBe('general')
  })

  it('keeps a requested Updates tab while the update status is loading', () => {
    expect(resolveAdminTab('updates', { updatesAvailable: 'pending' })).toBe('updates')
  })

  it('falls back to General when the deployment has no update status', () => {
    expect(resolveAdminTab('updates', { updatesAvailable: false })).toBe('general')
  })
})
