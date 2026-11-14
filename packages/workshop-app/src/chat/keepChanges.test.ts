import { describe, expect, it } from 'vitest'
import type { ProposedChanges } from './autoAccept'
import { keepChangeLines, keepReason } from './keepChanges'

const none: ProposedChanges = { created: [], bindings: [], updates: [], mainline: false, conflicts: [] }
const ask = (changes: Partial<ProposedChanges>, shared = false) => ({ changes: { ...none, ...changes }, shared })
const titles = new Map([[3, 'Tip Jar']])
const titleOf = (id: number) => titles.get(id)

describe('keepChangeLines', () => {
  it('names each gadget by its title, or the one the changes gave it', () => {
    expect(keepChangeLines(ask({
      created: [{ gadgetId: 9, title: 'Standup notes' }],
      bindings: [{ gadgetId: 3, name: 'JIRA' }, { gadgetId: 9, name: 'SLACK' }],
    }), titleOf)).toEqual([
      'Makes “Standup notes”',
      'Gives “Tip Jar” access to env.JIRA',
      'Gives “Standup notes” access to env.SLACK',
    ])
  })

  it('says “a gadget” for one it knows nothing of, and says a line once', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 4, name: 'JIRA' }, { gadgetId: 4, name: 'JIRA' }] }), titleOf))
      .toEqual(['Gives a gadget access to env.JIRA'])
  })

  it('counts the files left with conflicts', () => {
    expect(keepChangeLines(ask({ mainline: true, conflicts: ['a.ts', 'b.ts'] }), titleOf))
      .toEqual(['Brings in what was kept elsewhere since', 'Leaves 2 files with conflicts'])
  })
})

describe('keepReason', () => {
  it('gives the weightiest reason', () => {
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA' }], conflicts: ['a.ts'] }))).toMatch(/conflicts/)
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA' }] }, true))).toMatch(/yours to decide/)
    expect(keepReason(ask({}, true))).toMatch(/Others/)
  })
})
