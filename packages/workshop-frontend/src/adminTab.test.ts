import { describe, expect, it } from 'vitest'
import { resolveAdminTab } from './adminTab'

describe('resolveAdminTab', () => {
  it('shows the requested tab when it exists', () => {
    expect(resolveAdminTab('models', { updatesAvailable: false, auditAvailable: false })).toBe('models')
    expect(resolveAdminTab('updates', { updatesAvailable: true, auditAvailable: true })).toBe('updates')
    expect(resolveAdminTab('audit', { updatesAvailable: false, auditAvailable: true })).toBe('audit')
  })

  it('shows General for no tab or an unknown one', () => {
    expect(resolveAdminTab(undefined, { updatesAvailable: true, auditAvailable: true })).toBe('general')
    expect(resolveAdminTab('billing', { updatesAvailable: true, auditAvailable: true })).toBe('general')
  })

  it('keeps a requested Updates tab while the update status is loading', () => {
    expect(resolveAdminTab('updates', { updatesAvailable: 'pending', auditAvailable: true })).toBe('updates')
  })

  it('falls back to General when the deployment has no update status', () => {
    expect(resolveAdminTab('updates', { updatesAvailable: false, auditAvailable: true })).toBe('general')
  })

  // A backend older than the admin audit log, which the router can serve this frontend beside.
  it('falls back to General when the backend has no admin audit log', () => {
    expect(resolveAdminTab('audit', { updatesAvailable: 'pending', auditAvailable: false })).toBe('general')
  })
})
