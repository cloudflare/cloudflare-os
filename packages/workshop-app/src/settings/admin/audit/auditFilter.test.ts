import { describe, expect, it } from 'vitest'
import type {
  AdminAccessRecord,
  AdminSettingRecord,
  AdminUserAccessRecord,
} from '@gadgets/workshop-shared/api'
import { AUDIT_METHOD_GROUPS, filterKey, isFiltered, targetUserOf } from './auditFilter'

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

describe('isFiltered and filterKey', () => {
  it('counts only filters that are set', () => {
    expect(isFiltered({})).toBe(false)
    expect(isFiltered({ admin: undefined })).toBe(false)
    expect(isFiltered({ kind: 'user' })).toBe(true)
  })

  it('tells filters apart, but not a filter left unset from one never set', () => {
    expect(filterKey({ admin: 'ada' })).not.toBe(filterKey({ owner: 'ada' }))
    expect(filterKey({ admin: undefined })).toBe(filterKey({}))
  })
})
