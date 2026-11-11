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
})
