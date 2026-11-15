import { describe, expect, it } from 'vitest'
import { ADMIN_WRITE_ACTIONS, type AdminWriteArgs } from '@gadgets/workshop-shared/api'
import {
  idsNote,
  namesWorkspaceIds,
  reasonShownNote,
  WRITE_ACTION_LABELS,
  WRITE_ARG_LABELS,
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
