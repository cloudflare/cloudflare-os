import { describe, expect, it } from 'vitest'
import type { ProposedChanges } from './autoAccept'
import { keepChangeLines, keepReason } from './keepChanges'

const none: ProposedChanges = { created: [], bindings: [], updates: [], mainline: false, conflicts: [] }
const ask = (changes: Partial<ProposedChanges>, shared = false) => ({ changes: { ...none, ...changes }, shared })
const titles = new Map([[3, 'Tip Jar'], [20, 'Joke'], [21, 'Paul Pierce']])
const titleOf = (id: number) => titles.get(id)

describe('keepChangeLines', () => {
  it('names each gadget by its title, or the one the changes gave it', () => {
    expect(keepChangeLines(ask({
      created: [{ gadgetId: 9, title: 'Standup notes' }],
      bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }, { gadgetId: 9, name: 'SLACK', target: 31 }],
    }), titleOf)).toEqual([
      'Makes “Standup notes”',
      'Gives “Tip Jar” access to env.JIRA',
      'Gives “Standup notes” access to env.SLACK',
    ])
  })

  it('says what is given by its name, to a spawner as to a gadget', () => {
    expect(keepChangeLines(ask({
      bindings: [{ gadgetId: 3, name: 'JOKE_WRITER', target: 20 }, { gadgetId: 20, name: 'PAUL_PIERCE_DOC', target: 21 }],
    }), titleOf)).toEqual(['Lets “Tip Jar” use “Joke”', 'Lets “Joke” use “Paul Pierce”'])
  })

  it('says “a gadget” for one it knows nothing of, and says a line once', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 4, name: 'JIRA', target: 30 }, { gadgetId: 4, name: 'JIRA', target: 30 }] }), titleOf))
      .toEqual(['Gives a gadget access to env.JIRA'])
  })

  it('counts the files left with conflicts', () => {
    expect(keepChangeLines(ask({ mainline: true, conflicts: ['a.ts', 'b.ts'] }), titleOf))
      .toEqual(['Brings in what was kept elsewhere since', 'Leaves 2 files with conflicts'])
  })
})

describe('keepReason', () => {
  it('gives the weightiest reason', () => {
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }], conflicts: ['a.ts'] }))).toMatch(/conflicts/)
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }] }, true))).toMatch(/yours to decide/)
    expect(keepReason(ask({}, true))).toMatch(/Others/)
  })
})
