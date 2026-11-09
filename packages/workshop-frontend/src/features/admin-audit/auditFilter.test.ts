import { describe, expect, it } from 'vitest'
import type {
  AdminAccessRecord,
  AdminSettingRecord,
  AdminUserAccessRecord,
} from '@gadgets/workshop-shared/api'
import { AUDIT_METHOD_GROUPS, auditFilterOf, auditQueryOf, sensitivityOf, targetUserOf } from './auditFilter'

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
  requested: 'full',
  access: 'full',
  exposed: 'metadata',
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
  requested: 'full',
  access: 'full',
  exposed: 'metadata',
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

  it('keeps a method and a sensitivity of a user’s account', () => {
    expect(auditFilterOf({ method: 'inspectUser', sensitivity: 'userMetadata' }))
      .toEqual({ method: 'inspectUser', sensitivity: 'userMetadata' })
  })

  it('leaves out a sensitivity the tab does not have', () => {
    expect(auditFilterOf({ sensitivity: 'user' })).toEqual({})
    expect(auditFilterOf({ sensitivity: ['content'] })).toEqual({})
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

describe('sensitivityOf', () => {
  it('reads a setting change as one', () => {
    expect(sensitivityOf(settingRecord)).toBe('setting')
  })

  it('reads a call that exposed content as a content read, into a workspace or a user’s account', () => {
    expect(sensitivityOf(workspaceRecord({ exposed: 'content' }))).toBe('content')
    expect(sensitivityOf(userRecord({ exposed: 'content' }))).toBe('content')
  })

  it('tells a workspace’s metadata from a user account’s', () => {
    expect(sensitivityOf(workspaceRecord())).toBe('metadata')
    expect(sensitivityOf(userRecord())).toBe('userMetadata')
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

describe('auditQueryOf', () => {
  it('asks for content reads of every kind', () => {
    expect(auditQueryOf({ sensitivity: 'content' })).toEqual({ exposed: 'content' })
  })

  it('asks for metadata by the kind it is of', () => {
    expect(auditQueryOf({ sensitivity: 'metadata' })).toEqual({ kind: 'workspace', exposed: 'metadata' })
    expect(auditQueryOf({ sensitivity: 'userMetadata' })).toEqual({ kind: 'user', exposed: 'metadata' })
  })

  it('asks for setting changes by their kind', () => {
    expect(auditQueryOf({ sensitivity: 'setting' })).toEqual({ kind: 'setting' })
  })

  it('passes the other filters on, with no kind when no sensitivity is set', () => {
    expect(auditQueryOf({ admin: 'ada', method: 'describe', owner: 'linus' }))
      .toEqual({ admin: 'ada', method: 'describe', owner: 'linus' })
  })
})
