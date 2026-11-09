import { describe, expect, it } from 'vitest'
import {
  ADMIN_SETTING_METHODS,
  ADMIN_WORKSPACE_METHODS,
  ADMIN_WRITE_ACTIONS,
  type AdminAuditRecord,
} from '@gadgets/workshop-shared/api'
import { auditFilterOf, auditQueryOf, sensitivityOf } from './auditFilter'

describe('auditFilterOf', () => {
  it('keeps an admin and an audited method', () => {
    expect(auditFilterOf({ tab: 'audit', admin: 'ada', method: 'setGatewayModelSettings' }))
      .toEqual({ admin: 'ada', method: 'setGatewayModelSettings' })
  })

  it('leaves out an empty or non-string admin and a method no record names', () => {
    expect(auditFilterOf({ admin: '', method: 'listAdminAudit' })).toEqual({})
    expect(auditFilterOf({ admin: 42, method: ['setSiteName'] })).toEqual({})
  })

  it('keeps a write action as a method, and "write" as a sensitivity', () => {
    for (const method of ADMIN_WRITE_ACTIONS) expect(auditFilterOf({ method })).toEqual({ method })
    expect(auditFilterOf({ sensitivity: 'write' })).toEqual({ sensitivity: 'write' })
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

describe('sensitivityOf', () => {
  const record = { at: new Date(0), admin: 'ada', sessionId: 'session-1', via: 'api' } as const
  const inWorkspace = {
    workspaceId: 'w1', workspaceOwner: 'grace', workspaceTitle: 'Plans', reason: 'Ticket 1',
  }

  it('is what a call into a workspace exposed', () => {
    const call = {
      ...record, ...inWorkspace, kind: 'workspace', method: 'getChat', args: { chatId: 3 },
      requested: 'full', access: 'full',
    } as const
    expect(sensitivityOf({ ...call, exposed: 'content' })).toBe('content')
    expect(sensitivityOf({ ...call, exposed: 'metadata' })).toBe('metadata')
  })

  it('is the kind of a setting change and of a step in a write', () => {
    const change: AdminAuditRecord = { ...record, kind: 'setting', method: 'setSiteName', changes: [] }
    expect(sensitivityOf(change)).toBe('setting')
    const step: AdminAuditRecord = {
      ...record, ...inWorkspace, kind: 'write', requestId: 'request-1', event: 'approved',
      method: 'stopAgent', args: { chatId: 3 }, requestedBy: 'ada',
    }
    expect(sensitivityOf(step)).toBe('write')
  })
})

describe('auditQueryOf', () => {
  it('asks for a content or metadata sensitivity by what the records exposed', () => {
    expect(auditQueryOf({ admin: 'ada', sensitivity: 'content' })).toEqual({ admin: 'ada', exposed: 'content' })
    expect(auditQueryOf({ sensitivity: 'metadata' })).toEqual({ exposed: 'metadata' })
  })

  it('asks for a setting or write sensitivity by the records’ kind', () => {
    expect(auditQueryOf({ sensitivity: 'setting' })).toEqual({ kind: 'setting' })
    expect(auditQueryOf({ sensitivity: 'write', workspace: 'w1' })).toEqual({ kind: 'write', workspace: 'w1' })
  })

  it('passes the other filters through', () => {
    expect(auditQueryOf({ method: 'stopAgent', owner: 'grace' })).toEqual({ method: 'stopAgent', owner: 'grace' })
  })
})
