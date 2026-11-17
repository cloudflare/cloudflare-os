import { describe, expect, it } from 'vitest'
import type {
  AdminAccessRecord,
  AdminSettingRecord,
  AdminUserAccessRecord,
} from '@gadgets/workshop-shared/api'
import { AUDIT_METHOD_GROUPS, auditFilterOf, targetUserOf } from './auditFilter'

const AT = new Date('2026-10-21T09:15:00Z')

const workspaceRecord = (patch: Partial<AdminAccessRecord> = {}): AdminAccessRecord => ({
  kind: 'workspace',
  at: AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'cli',
  workspaceId: 'ws-1',
  workspaceOwner: 'grace',
  workspaceTitle: 'Quarterly report',
  method: 'describe',
  args: {},
  reason: 'Agent stuck',
  access: 'metadata',
  ...patch,
})

const userRecord = (patch: Partial<AdminUserAccessRecord> = {}): AdminUserAccessRecord => ({
  kind: 'user',
  at: AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'cli',
  userId: 'linus',
  method: 'describe',
  args: {},
  reason: 'Cannot sign in',
  access: 'metadata',
  ...patch,
})

const settingRecord: AdminSettingRecord = {
  kind: 'setting',
  at: AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'api',
  method: 'setSiteName',
  changes: [{ setting: 'siteName', before: 'Old name', after: 'New name' }],
}

describe('auditFilterOf', () => {
  it('keeps an admin and an audited method', () => {
    expect(auditFilterOf({ tab: 'audit', admin: 'ada', method: 'setGatewayModelSettings' }))
      .toEqual({ admin: 'ada', method: 'setGatewayModelSettings' })
  })

  it('leaves out an empty or non-string admin and a method no record names', () => {
    expect(auditFilterOf({ admin: '', method: 'listAdminAudit' })).toEqual({})
    expect(auditFilterOf({ admin: 42, method: ['setSiteName'] })).toEqual({})
  })

  it.each(['workspace', 'user', 'setting'] as const)('keeps the kind %s', (kind) => {
    expect(auditFilterOf({ kind })).toEqual({ kind })
  })

  it('keeps a method of a user’s account', () => {
    expect(auditFilterOf({ method: 'inspectUser', kind: 'user' }))
      .toEqual({ method: 'inspectUser', kind: 'user' })
  })

  it('leaves out a kind that is not one, and a parameter that is no filter', () => {
    expect(auditFilterOf({ kind: 'content' })).toEqual({})
    expect(auditFilterOf({ kind: 1 })).toEqual({})
    expect(auditFilterOf({ sensitivity: 'content' })).toEqual({})
  })
})

describe('AUDIT_METHOD_GROUPS', () => {
  // Both views have a describe(), and the Action filter lists a method once.
  it('names each method once, the ones a workspace’s view and a user account’s share included', () => {
    const methods = AUDIT_METHOD_GROUPS.flatMap((group) => group.methods)

    expect(methods).toContain('inspectUser')
    expect(methods.filter((method) => method === 'describe')).toEqual(['describe'])
    expect(new Set(methods).size).toBe(methods.length)
  })
})

describe('targetUserOf', () => {
  it('is a workspace’s owner, or the user whose account was inspected', () => {
    expect(targetUserOf(workspaceRecord())).toBe('grace')
    expect(targetUserOf(userRecord())).toBe('linus')
  })

  it('is no one for a workspace whose owner is unknown, and for a setting change', () => {
    expect(targetUserOf(workspaceRecord({ workspaceOwner: '' }))).toBeUndefined()
    expect(targetUserOf(settingRecord)).toBeUndefined()
  })
})
