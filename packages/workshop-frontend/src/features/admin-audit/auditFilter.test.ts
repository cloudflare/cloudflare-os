import { describe, expect, it } from 'vitest'
import {
  ADMIN_SETTING_METHODS,
  ADMIN_USER_METHODS,
  ADMIN_WORKSPACE_METHODS,
  ADMIN_WRITE_ACTIONS,
  type AdminAccessRecord,
  type AdminSettingRecord,
  type AdminUserAccessRecord,
} from '@gadgets/workshop-shared/api'
import {
  AUDIT_METHOD_GROUPS, auditFilterOf, targetUserOf, withPendingRequests, withoutUnmatchedPending,
} from './auditFilter'

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
  requested: 'metadata',
  access: 'metadata',
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

  it('keeps pending only when the URL says true', () => {
    expect(auditFilterOf({ pending: true })).toEqual({ pending: true })
    for (const pending of [false, 'true', 1, 'yes']) expect(auditFilterOf({ pending })).toEqual({})
  })

  it('leaves out a kind that is not one, and a parameter that is no filter', () => {
    expect(auditFilterOf({ kind: 'content' })).toEqual({})
    expect(auditFilterOf({ kind: 1 })).toEqual({})
    expect(auditFilterOf({ sensitivity: 'content' })).toEqual({})
  })

  it.each(['content', 'metadata'] as const)('keeps what a call exposed, %s', (exposed) => {
    expect(auditFilterOf({ tab: 'audit', exposed })).toEqual({ exposed })
  })

  it('leaves out an exposure that is not one', () => {
    expect(auditFilterOf({ exposed: 'full' })).toEqual({})
    expect(auditFilterOf({ exposed: ['content'] })).toEqual({})
    expect(auditFilterOf({ exposed: '' })).toEqual({})
  })

  it('keeps a write action as a method, and "write" as a kind', () => {
    for (const method of ADMIN_WRITE_ACTIONS) expect(auditFilterOf({ method })).toEqual({ method })
    expect(auditFilterOf({ kind: 'write' })).toEqual({ kind: 'write' })
  })
})

describe('withPendingRequests', () => {
  it('drops what a request cannot match and keeps who and where', () => {
    expect(withPendingRequests({
      admin: 'ada', workspace: 'ws-1', owner: 'olive', exposed: 'content', kind: 'workspace', method: 'readFile',
    })).toStrictEqual({ admin: 'ada', workspace: 'ws-1', owner: 'olive', pending: true })
  })

  it('keeps the Kind and Action of a request', () => {
    expect(withPendingRequests({ kind: 'grant', method: 'requestContentAccess' }))
      .toStrictEqual({ kind: 'grant', method: 'requestContentAccess', pending: true })
  })
})

describe('withoutUnmatchedPending', () => {
  it('drops Pending once Exposed, or a Kind or Action no request record has, is chosen', () => {
    for (const chosen of [{ exposed: 'content' }, { kind: 'workspace' }, { method: 'readFile' }] as const) {
      expect(withoutUnmatchedPending({ admin: 'ada', pending: true, ...chosen }))
        .toStrictEqual({ admin: 'ada', pending: undefined, ...chosen })
    }
  })

  it('keeps Pending with a request\'s Kind or Action, and a filter without Pending as it is', () => {
    const request = { pending: true, kind: 'grant', method: 'requestContentAccess' } as const
    expect(withoutUnmatchedPending(request)).toBe(request)
    const unpending = { exposed: 'content' } as const
    expect(withoutUnmatchedPending(unpending)).toBe(unpending)
  })
})

describe('the write actions', () => {
  // One method filter selects records of every kind (AdminAuditQuery.method), so a write action
  // names write records alone only while no other kind of record has a method of its name.
  it('share no name with a method of another kind of record', () => {
    const others = new Set<string>([...ADMIN_WORKSPACE_METHODS, ...ADMIN_USER_METHODS, ...ADMIN_SETTING_METHODS])
    expect(ADMIN_WRITE_ACTIONS.filter((action) => others.has(action))).toEqual([])
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
