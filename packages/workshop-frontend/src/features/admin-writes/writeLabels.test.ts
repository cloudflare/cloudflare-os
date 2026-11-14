import { describe, expect, it } from 'vitest'
import { ADMIN_WRITE_ACTIONS, type AdminWriteArgs } from '@gadgets/workshop-shared/api'
import {
  DESTRUCTIVE_WRITES,
  idsNote,
  namesWorkspaceIds,
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

    expect(writeArgRows('deleteChat', reversed).map((row) => row.label))
      .toEqual(Object.values(WRITE_ARG_LABELS))
  })

  it('has no rows for an action that takes no arguments', () => {
    expect(writeArgRows('restartWorkspace', {})).toEqual([])
  })

  it('says a rejection without a connection covers every connection', () => {
    expect(writeArgRows('rejectPendingActions', {})).toEqual([{ label: 'Connection', value: 'Every connection' }])
    expect(writeArgRows('rejectPendingActions', { gatekeeperId: 7 })).toEqual([{ label: 'Connection', value: '7' }])
  })

  it('gives no default to an action whose arguments are all required', () => {
    expect(writeArgRows('deleteChat', { chatId: 3 })).toEqual([{ label: 'Chat', value: '3' }])
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
  it('counts as destructive the writes nothing can take back', () => {
    expect([...DESTRUCTIVE_WRITES].toSorted()).toEqual(['deleteChat', 'rejectPendingActions'])
  })

  it('states a consequence for exactly the writes whose request does not say it', () => {
    expect(Object.keys(WRITE_CONSEQUENCES)).toEqual(['rejectPendingActions'])
    expect(WRITE_CONSEQUENCES.rejectPendingActions).toContain('that connection is removed')
  })
})
