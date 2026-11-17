import { describe, expect, it } from 'vitest'
import { auditFilterOf } from './auditFilter'

describe('auditFilterOf', () => {
  it('keeps an admin and an audited method', () => {
    expect(auditFilterOf({ tab: 'audit', admin: 'ada', method: 'setGatewayModelSettings' }))
      .toEqual({ admin: 'ada', method: 'setGatewayModelSettings' })
  })

  it('leaves out an empty or non-string admin and a method no record names', () => {
    expect(auditFilterOf({ admin: '', method: 'listAdminAudit' })).toEqual({})
    expect(auditFilterOf({ admin: 42, method: ['setSiteName'] })).toEqual({})
  })

  it.each(['workspace', 'setting'] as const)('keeps the kind %s', (kind) => {
    expect(auditFilterOf({ kind })).toEqual({ kind })
  })

  it('leaves out a kind that is not one, and a parameter that is no filter', () => {
    expect(auditFilterOf({ kind: 'content' })).toEqual({})
    expect(auditFilterOf({ kind: 1 })).toEqual({})
    expect(auditFilterOf({ sensitivity: 'content' })).toEqual({})
  })
})
