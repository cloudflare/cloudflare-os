import { describe, expect, it } from 'vitest'
import {
  ADMIN_SETTING_METHODS,
  ADMIN_WORKSPACE_METHODS,
  ADMIN_WRITE_ACTIONS,
} from '@gadgets/workshop-shared/api'
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

  it('keeps a write action as a method, and "write" as a kind', () => {
    for (const method of ADMIN_WRITE_ACTIONS) expect(auditFilterOf({ method })).toEqual({ method })
    expect(auditFilterOf({ kind: 'write' })).toEqual({ kind: 'write' })
  })
})

describe('the methods audit records name', () => {
  // One method filter selects records of every kind (AdminAuditQuery.method), so it names records
  // of one kind only while no name belongs to two.
  it('belong to one kind of record each', () => {
    const names = [...ADMIN_WORKSPACE_METHODS, ...ADMIN_SETTING_METHODS, ...ADMIN_WRITE_ACTIONS]
    expect(new Set(names).size).toBe(names.length)
  })
})
