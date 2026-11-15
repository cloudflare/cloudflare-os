import { describe, expect, it } from 'vitest'
import {
  ADMIN_ACCESS_ERROR_CODES,
  ADMIN_GRANT_ERROR_CODES,
  ADMIN_GRANT_LIFETIME_SECONDS,
  ADMIN_WRITE_ACTIONS,
  ADMIN_WRITE_ERROR_CODES,
  createAdminAccessError,
  createAdminGrantError,
  createAdminWriteError,
  type AdminWriteArgs,
} from '@gadgets/workshop-shared/api'
import {
  adminRefusalMessage,
  awaitsAnotherAdmin,
  idsNote,
  namesWorkspaceIds,
  reasonShownNote,
  WRITE_ACTION_LABELS,
  WRITE_ARG_LABELS,
  WRITE_CONSEQUENCES,
  writeArgRows,
} from './writeLabels'

// Every argument a request can carry, each with a value.
const EVERY_ARG: Required<AdminWriteArgs> = {
  chatId: 3,
  gatekeeperId: 7,
}

describe('write labels', () => {
  it('names every action', () => {
    for (const action of ADMIN_WRITE_ACTIONS) expect(WRITE_ACTION_LABELS[action]).toBeTruthy()
    expect(Object.keys(WRITE_ACTION_LABELS).toSorted()).toEqual([...ADMIN_WRITE_ACTIONS].toSorted())
  })

  it('says plainly what a request to read content lets admins do, for as long as a grant lasts', () => {
    expect(ADMIN_GRANT_LIFETIME_SECONDS).toBe(72 * 60 * 60)
    expect(WRITE_ACTION_LABELS.grantContentAccess)
      .toBe("Let admins read this workspace's content for 72 hours, without its owner's grant")
  })

  it('names every argument', () => {
    for (const key of Object.keys(EVERY_ARG) as (keyof AdminWriteArgs)[]) {
      expect(WRITE_ARG_LABELS[key]).toBeTruthy()
    }
    expect(Object.keys(WRITE_ARG_LABELS).toSorted()).toEqual(Object.keys(EVERY_ARG).toSorted())
  })
})

describe('writeArgRows', () => {
  it('lists the arguments in the order of their labels, whatever order the request holds them in', () => {
    const reversed = Object.fromEntries(Object.entries(EVERY_ARG).toReversed()) as AdminWriteArgs

    expect(writeArgRows('stopAgent', reversed).map((row) => row.label))
      .toEqual(Object.values(WRITE_ARG_LABELS))
  })

  it('has no rows for an action that takes no arguments', () => {
    expect(writeArgRows('restartWorkspace', {})).toEqual([])
  })

  it('gives no default to an action whose arguments are all required', () => {
    expect(writeArgRows('stopAgent', { chatId: 3 })).toEqual([{ label: 'Chat', value: '3' }])
  })
})

describe('namesWorkspaceIds', () => {
  it.each<[string, AdminWriteArgs]>([
    ['a chat', { chatId: 0 }],
    ['a connection', { gatekeeperId: 7 }],
  ])('is true for arguments that name %s', (_what, args) => {
    expect(namesWorkspaceIds(args)).toBe(true)
  })

  it('is false for arguments that name nothing in the workspace', () => {
    expect(namesWorkspaceIds({})).toBe(false)
  })
})

describe('reasonShownNote', () => {
  const changes = ADMIN_WRITE_ACTIONS.filter((action) => action !== 'grantContentAccess')

  it('says a change’s reason is shown in the workspace’s activity', () => {
    expect(changes).toHaveLength(2)
    for (const action of changes) {
      expect(reasonShownNote(action)).toBe(reasonShownNote('stopAgent'))
    }
    expect(reasonShownNote('stopAgent')).toContain("workspace's activity")
    expect(reasonShownNote('stopAgent')).toContain('owner and everyone invited')
  })

  it('says the reason of a request to read content stays with the admins', () => {
    const note = reasonShownNote('grantContentAccess')

    expect(note).toContain("admins' audit log")
    expect(note).toContain('not told')
    expect(note).not.toContain('activity')
    expect(note).not.toContain('owner and everyone invited')
    expect(note).not.toContain('shown, word for word')
  })
})

describe('idsNote', () => {
  it('advises an inspection where the deployment allows one', () => {
    expect(idsNote('metadata')).toContain('shown by the ids the request names')
    expect(idsNote('metadata')).toContain('inspect the workspace')
  })

  it('says ids cannot be checked where inspection is off, and advises none', () => {
    expect(idsNote('off')).toContain('shown by the ids the request names')
    expect(idsNote('off')).toContain('what an id names cannot be checked here')
    expect(idsNote('off')).toContain('off on this deployment')
    expect(idsNote('off')).not.toContain('inspect the workspace')
  })
})

describe('what an approver is warned of', () => {
  it('states a consequence for exactly the writes whose request does not say it', () => {
    expect(Object.keys(WRITE_CONSEQUENCES)).toEqual(['grantContentAccess'])
  })

  it('says of a request to read content that the owner is not told and that every read is recorded', () => {
    const consequence = WRITE_CONSEQUENCES.grantContentAccess

    expect(consequence).toContain('for 72 hours')
    expect(consequence).toContain("The workspace's owner is not told")
    expect(consequence).toContain('recorded in the audit log')
    expect(consequence).not.toContain('activity')
  })
})

describe('awaitsAnotherAdmin', () => {
  const request = { action: 'grantContentAccess', requestedBy: 'alice@example.com' } as const

  it('is true for the admin who asked to read content', () => {
    expect(awaitsAnotherAdmin(request, 'alice@example.com')).toBe(true)
  })

  it('takes names that differ only by the case of ASCII letters for one admin, as the server does', () => {
    expect(awaitsAnotherAdmin(request, 'Alice@Example.COM')).toBe(true)
    // The Kelvin sign lowers to "k" under toLowerCase(), and is another name all the same.
    expect(awaitsAnotherAdmin({ ...request, requestedBy: 'kim' }, '\u212Aim')).toBe(false)
  })

  it('is false for any other admin', () => {
    expect(awaitsAnotherAdmin(request, 'bob@example.com')).toBe(false)
  })

  it('is false for the requester of every other write, which they may approve themselves', () => {
    for (const action of ADMIN_WRITE_ACTIONS.filter((each) => each !== 'grantContentAccess')) {
      expect(awaitsAnotherAdmin({ action, requestedBy: 'alice@example.com' }, 'alice@example.com')).toBe(false)
    }
  })
})

describe('adminRefusalMessage', () => {
  it('is the server’s message for a refusal of each family it names by code', () => {
    const refusals = [
      createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired),
      createAdminWriteError(ADMIN_WRITE_ERROR_CODES.writesOff),
      createAdminGrantError(ADMIN_GRANT_ERROR_CODES.notFound),
    ]

    for (const refusal of refusals) expect(adminRefusalMessage(refusal)).toBe(refusal.message)
  })

  it('is undefined for a failure that carries no such code', () => {
    expect(adminRefusalMessage(new Error('The connection was lost'))).toBeUndefined()
    expect(adminRefusalMessage(Object.assign(new Error('Other'), { code: 'SOMETHING_ELSE' }))).toBeUndefined()
    expect(adminRefusalMessage('ADMIN_VIEW_EXPIRED')).toBeUndefined()
  })
})
