import { describe, expect, it } from 'vitest'
import type { AdminSettingsView } from '@gadgets/workshop-shared/api'
import { reportRetentionOf } from './reportSettings'

describe('reportRetentionOf', () => {
  it('gives the retention from a view that carries it', () => {
    const retention = { effective: 120, chosen: 30, min: 120 }

    expect(reportRetentionOf({ issueReportRetentionDays: retention, signupsEnabled: true })).toEqual(retention)
  })

  // What a backend with no issue report store sends.
  it('gives null for a view lacking it', () => {
    expect(reportRetentionOf({})).toBeNull()
  })

  it.each([
    ['a number', 90],
    ['null', null],
    ['a retention missing a field', { effective: 90, chosen: 90 }],
    ['a retention whose field is not a number', { effective: 90, chosen: '90', min: 90 }],
  ])('gives null for %s', (_name, issueReportRetentionDays) => {
    expect(reportRetentionOf({ issueReportRetentionDays } as unknown as Partial<AdminSettingsView>)).toBeNull()
  })
})
