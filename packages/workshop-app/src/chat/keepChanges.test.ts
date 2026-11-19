import { describe, expect, it } from 'vitest'
import type { ProposedChanges } from './proposedChanges'
import { keepChangeLines, keepReason } from './keepChanges'

const none: ProposedChanges = { created: [], edited: [], bindings: [], updates: [], mainline: false, conflicts: [], files: {} }
const ask = (changes: Partial<ProposedChanges>) => ({ changes: { ...none, ...changes }, sending: false, epoch: undefined })
const titles = new Map([[3, 'Tip Jar'], [20, 'Joke'], [21, 'Paul Pierce']])
const titleOf = (id: number) => titles.get(id)

describe('keepChangeLines', () => {
  it('names each gadget by its title, or the one the changes gave it', () => {
    expect(keepChangeLines(ask({
      created: [{ gadgetId: 9, title: 'Standup notes' }],
      bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }, { gadgetId: 9, name: 'SLACK', target: 31 }],
    }), titleOf)).toEqual([
      'Creates “Standup notes”',
      'Connects “Tip Jar” to a connection',
      'Connects “Standup notes” to a connection',
    ])
  })

  it('says what is given by its name, to a spawner as to a gadget', () => {
    expect(keepChangeLines(ask({
      bindings: [{ gadgetId: 3, name: 'JOKE_WRITER', target: 20 }, { gadgetId: 20, name: 'PAUL_PIERCE_DOC', target: 21 }],
    }), titleOf)).toEqual(['Connects “Tip Jar” to “Joke”', 'Connects “Joke” to “Paul Pierce”'])
  })

  it('says “a gadget” for one it knows nothing of, and says a line once', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 4, name: 'JIRA', target: 30 }, { gadgetId: 4, name: 'JIRA', target: 30 }] }), titleOf))
      .toEqual(['Connects a gadget to a connection'])
  })

  it('names what a binding reaches by its resource’s title where it is known', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 3, name: 'TEST_DOC', target: 30 }] }), titleOf, (gadgetId, name) => (gadgetId === 3 && name === 'TEST_DOC' ? { title: 'Q3 plan' } : undefined)))
      .toEqual(['Connects “Tip Jar” to “Q3 plan”'])
  })

  it('says a model as what the gadget may use, by the model’s name', () => {
    expect(keepChangeLines(ask({ bindings: [{ gadgetId: 3, name: 'LLM', target: 30 }] }), titleOf, () => ({ title: 'Claude Haiku', model: true })))
      .toEqual(['Lets “Tip Jar” use Claude Haiku'])
  })

  it('says nothing of a gadget whose code alone changes, which is listed as itself', () => {
    expect(keepChangeLines(ask({ created: [{ gadgetId: 9, title: 'Standup notes' }], edited: [3, 4] }), titleOf))
      .toEqual(['Creates “Standup notes”'])
  })

  it('counts the files left with conflicts', () => {
    expect(keepChangeLines(ask({ mainline: true, conflicts: ['a.ts', 'b.ts'] }), titleOf))
      .toEqual(['Brings in changes kept elsewhere since this chat began', 'Leaves 2 files with conflicts to fix'])
  })
})

describe('keepReason', () => {
  it('gives the weightiest reason', () => {
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }], conflicts: ['a.ts'] }))).toMatch(/conflicts/)
    expect(keepReason(ask({ bindings: [{ gadgetId: 3, name: 'JIRA', target: 30 }] }))).toMatch(/needs your OK/)
    expect(keepReason(ask({ updates: [{ gadgetId: 3, title: 'Docs' }] }))).toMatch(/updates/)
  })

  it('has nothing to say of code alone', () => {
    expect(keepReason(ask({ edited: [3] }))).toBeUndefined()
  })
})
