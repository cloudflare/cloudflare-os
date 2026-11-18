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
      'Creates “Standup notes”',
      'Connects “Tip Jar” to JIRA',
      'Connects “Standup notes” to SLACK',
    ])
  })

  it('says what is given by its name, to a spawner as to a gadget', () => {
    expect(keepChangeLines(ask({
      bindings: [{ gadgetId: 3, name: 'JOKE_WRITER', target: 20 }, { gadgetId: 20, name: 'PAUL_PIERCE_DOC', target: 21 }],
    }), titleOf)).toEqual(['Connects “Tip Jar” to “Joke”', 'Connects “Joke” to “Paul Pierce”'])
  })

  it('says “a gadget” for one it knows nothing of, and says a line once', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 4, name: 'JIRA', target: 30 }, { gadgetId: 4, name: 'JIRA', target: 30 }] }), titleOf))
      .toEqual(['Connects a gadget to JIRA'])
  })

  it('counts the files left with conflicts', () => {
    expect(keepChangeLines(ask({ mainline: true, conflicts: ['a.ts', 'b.ts'] }), titleOf))
      .toEqual(['Brings in changes kept elsewhere since this chat began', 'Leaves 2 files with conflicts to fix'])
  })
})

describe('keepReason', () => {
  it('gives the weightiest reason', () => {
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }], conflicts: ['a.ts'] }))).toMatch(/conflicts/)
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }] }, true))).toMatch(/needs your OK/)
    expect(keepReason(ask({}, true))).toMatch(/Others/)
  })
})
