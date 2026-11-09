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
  modelId: 'model-a',
  revertFrom: 12,
  gadgetId: 5,
  commitId: 'a'.repeat(40),
  gatekeeperId: 7,
  username: 'bob',
  grant: 'workspace',
  note: 'For the incident',
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

    expect(writeArgRows('addCollaborator', reversed).map((row) => row.label))
      .toEqual(Object.values(WRITE_ARG_LABELS))
  })

  it('shows a grant of the whole workspace and a grant of one gadget', () => {
    expect(writeArgRows('addCollaborator', { username: 'bob', grant: 'workspace', note: 'workspace' })).toEqual([
      { label: 'User', value: 'bob' },
      { label: 'Grant', value: 'The whole workspace' },
      { label: 'Note', value: 'workspace' },
    ])
    expect(writeArgRows('addCollaborator', { username: 'bob', grant: { gadgetId: 5 } })).toEqual([
      { label: 'User', value: 'bob' },
      { label: 'Grant', value: 'Gadget 5' },
    ])
  })

  it('has no rows for an action that takes no arguments', () => {
    expect(writeArgRows('restartWorkspace', {})).toEqual([])
  })

  it('says a rejection without a connection covers every connection', () => {
    expect(writeArgRows('rejectPendingActions', {})).toEqual([{ label: 'Connection', value: 'Every connection' }])
    expect(writeArgRows('rejectPendingActions', { gatekeeperId: 7 })).toEqual([{ label: 'Connection', value: '7' }])
  })

  it('says a retry without a model runs on the chat’s most recent one', () => {
    expect(writeArgRows('retryAgent', { chatId: 3 })).toEqual([
      { label: 'Chat', value: '3' },
      { label: 'Model', value: "The chat's most recent one" },
    ])
    expect(writeArgRows('retryAgent', { chatId: 3, modelId: 'model-a' })).toEqual([
      { label: 'Chat', value: '3' },
      { label: 'Model', value: 'model-a' },
    ])
  })

  it('gives no default to an action whose arguments are all required', () => {
    expect(writeArgRows('removeConnection', { gatekeeperId: 7 })).toEqual([{ label: 'Connection', value: '7' }])
    expect(writeArgRows('stopAgent', { chatId: 3 })).toEqual([{ label: 'Chat', value: '3' }])
  })
})

describe('namesWorkspaceIds', () => {
  it.each<[string, AdminWriteArgs]>([
    ['a chat', { chatId: 0 }],
    ['a gadget', { gadgetId: 5 }],
    ['a connection', { gatekeeperId: 7 }],
    ['a version', { commitId: 'a'.repeat(40) }],
    ['a grant of one gadget', { username: 'bob', grant: { gadgetId: 5 } }],
  ])('is true for arguments that name %s', (_what, args) => {
    expect(namesWorkspaceIds(args)).toBe(true)
  })

  it('is false for arguments that name nothing in the workspace', () => {
    expect(namesWorkspaceIds({})).toBe(false)
    expect(namesWorkspaceIds({ username: 'bob', grant: 'workspace' })).toBe(false)
  })
})

describe('idsNote', () => {
  it('advises an inspection where the deployment allows one', () => {
    for (const access of ['metadata', 'full'] as const) {
      expect(idsNote(access)).toContain('shown by the ids the request names')
      expect(idsNote(access)).toContain('inspect the workspace')
    }
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
    expect([...DESTRUCTIVE_WRITES].toSorted()).toEqual([
      'deleteChat', 'deleteGadget', 'deleteWorkspace', 'rejectPendingActions', 'removeConnection', 'revertChat',
    ])
  })

  it('states a consequence for exactly the writes whose request does not say it', () => {
    expect(Object.keys(WRITE_CONSEQUENCES).toSorted())
      .toEqual(['addCollaborator', 'deleteWorkspace', 'rejectPendingActions', 'retryAgent'])
    expect(WRITE_CONSEQUENCES.retryAgent).toContain('the owner pays for it')
    expect(WRITE_CONSEQUENCES.addCollaborator).toContain('as if the owner had added them')
    expect(WRITE_CONSEQUENCES.deleteWorkspace).toContain('nobody who uses the workspace is told')
    expect(WRITE_CONSEQUENCES.rejectPendingActions).toContain('that connection is removed')
  })
})
