import { describe, expect, it } from 'vitest'
import { auditSettingsOf, type AuditSettings } from './auditSettings'

const complete = (): AuditSettings => ({
  adminAuditRetentionDays: { effective: 120, chosen: 30, min: 120 },
})

describe('auditSettingsOf', () => {
  it('gives the retention from a view that carries it', () => {
    expect(auditSettingsOf({ ...complete(), signupsEnabled: true } as Partial<AuditSettings>))
      .toEqual(complete())
  })

  // What a backend older than the admin audit log sends.
  it('gives null for a view lacking it', () => {
    expect(auditSettingsOf({})).toBeNull()
  })

  it.each([
    ['a retention that is not an object', { adminAuditRetentionDays: 90 }],
    ['a retention whose minimum is not a number', {
      adminAuditRetentionDays: { effective: 90, chosen: 90, min: '90' },
    }],
    ['a null retention', { adminAuditRetentionDays: null }],
  ])('gives null for %s', (_name, patch) => {
    expect(auditSettingsOf({ ...complete(), ...patch } as unknown as Partial<AuditSettings>)).toBeNull()
  })
})
