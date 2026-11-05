import { describe, expect, it } from 'vitest'
import { auditSettingsOf, type AuditSettings } from './auditSettings'

const complete = (): AuditSettings => ({
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'full', max: 'metadata' },
  adminAuditRetentionDays: { effective: 120, chosen: 30, min: 120 },
})

describe('auditSettingsOf', () => {
  it('gives the pair from a view that carries both', () => {
    expect(auditSettingsOf({ ...complete(), signupsEnabled: true } as Partial<AuditSettings>))
      .toEqual(complete())
  })

  // What a backend older than the admin audit log sends.
  it('gives null for a view lacking both', () => {
    expect(auditSettingsOf({})).toBeNull()
  })

  it.each(['adminWorkspaceAccess', 'adminAuditRetentionDays'] as const)(
    'gives null for a view lacking %s', (field) => {
      const view: Partial<AuditSettings> = complete()
      delete view[field]
      expect(auditSettingsOf(view)).toBeNull()
    })

  it.each([
    ['an access level that is not an object', { adminWorkspaceAccess: 'full' }],
    ['an access level that is not a level', {
      adminWorkspaceAccess: { effective: 'metadata', chosen: 'everything', max: 'metadata' },
    }],
    ['an access level without its maximum', {
      adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata' },
    }],
    ['a retention that is not an object', { adminAuditRetentionDays: 90 }],
    ['a retention whose minimum is not a number', {
      adminAuditRetentionDays: { effective: 90, chosen: 90, min: '90' },
    }],
    ['a null retention', { adminAuditRetentionDays: null }],
  ])('gives null for %s', (_name, patch) => {
    expect(auditSettingsOf({ ...complete(), ...patch } as unknown as Partial<AuditSettings>)).toBeNull()
  })
})
