import { describe, expect, it } from 'vitest'
import { resolveAdminTab } from './adminTab'

const ALL = { updatesAvailable: true, auditAvailable: true, reportsAvailable: true } as const
const NONE = { updatesAvailable: false, auditAvailable: false, reportsAvailable: false } as const

describe('resolveAdminTab', () => {
  it('shows the requested tab when it exists', () => {
    expect(resolveAdminTab('models', NONE)).toBe('models')
    expect(resolveAdminTab('updates', ALL)).toBe('updates')
    expect(resolveAdminTab('audit', { ...NONE, auditAvailable: true })).toBe('audit')
    expect(resolveAdminTab('reports', { ...NONE, reportsAvailable: true })).toBe('reports')
  })

  it('shows General for no tab or an unknown one', () => {
    expect(resolveAdminTab(undefined, ALL)).toBe('general')
    expect(resolveAdminTab('billing', ALL)).toBe('general')
  })

  it('keeps a requested Updates tab while the update status is loading', () => {
    expect(resolveAdminTab('updates', { ...ALL, updatesAvailable: 'pending' })).toBe('updates')
  })

  it('falls back to General when the deployment has no update status', () => {
    expect(resolveAdminTab('updates', { ...ALL, updatesAvailable: false })).toBe('general')
  })

  // A backend older than the admin audit log, which the router can serve this frontend beside.
  it('falls back to General when the backend has no admin audit log', () => {
    expect(resolveAdminTab('audit', { ...ALL, updatesAvailable: 'pending', auditAvailable: false })).toBe('general')
  })

  // A backend with no issue report store, which the router can serve this frontend beside.
  it('falls back to General when the backend keeps no issue reports', () => {
    expect(resolveAdminTab('reports', { ...ALL, reportsAvailable: false })).toBe('general')
  })
})
