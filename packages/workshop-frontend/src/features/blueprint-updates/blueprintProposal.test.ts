import { describe, expect, it } from 'vitest'
import type { AiChatMessage, BlueprintMerge } from '@gadgets/workshop-shared/api'
import {
  appliedBlueprintMerges,
  describeBlueprintProposal,
  proposalMessageCount,
} from './blueprintProposal'

const merge = (over: Partial<BlueprintMerge> = {}): BlueprintMerge => ({
  gadgetId: 1,
  blueprintId: 'blueprint',
  title: 'Trip planner',
  version: 3,
  commitId: 'release',
  kind: 'merge',
  baseCommit: 'base',
  conflictPaths: [],
  ...over,
})

describe('describeBlueprintProposal', () => {
  it('names the blueprint and the version proposed', () => {
    expect(describeBlueprintProposal(merge(), { changesFiles: true }).heading)
      .toBe('Trip planner, version 3')
    expect(describeBlueprintProposal(merge({ title: '' }), { changesFiles: true }).heading)
      .toBe('Untitled blueprint, version 3')
  })

  it('says a follow changes no file, only what the gadget takes updates from', () => {
    const notice = describeBlueprintProposal(merge({ kind: 'follow' }), { changesFiles: false })
    expect(notice.summary).toContain('None of this gadget’s files change')
    expect(notice.summary).toContain('take its future updates from this blueprint')
    expect(notice.nextStep).toBe('Nothing changes until you accept.')
  })

  it('says a fast-forward makes the files the version’s exactly, and to try it first', () => {
    const notice = describeBlueprintProposal(merge({ kind: 'fastForward' }), { changesFiles: true })
    expect(notice.summary).toContain('its files become this version’s exactly')
    expect(notice.nextStep).toBe('Nothing changes until you accept. Try this version in the preview first.')
  })

  it('says a merge combined the changes of both sides', () => {
    const notice = describeBlueprintProposal(merge(), { changesFiles: true })
    expect(notice.summary).toContain('have both changed')
    expect(notice.nextStep).toContain('Try this version in the preview first.')
    expect(notice.conflicts).toBeUndefined()
    expect(notice.warning).toBeUndefined()
  })

  it('says a merge of two sides that made the same changes changes no file', () => {
    const notice = describeBlueprintProposal(merge(), { changesFiles: false })
    expect(notice.summary).toContain('already has every change this version made')
    expect(notice.nextStep).toBe('Nothing changes until you accept.')
  })

  it('names the conflicted files, and says that one of them may have no marks', () => {
    const notice = describeBlueprintProposal(
      merge({ conflictPaths: ['client.js', 'lib/dates.js'] }), { changesFiles: true })
    expect(notice.conflicts).toContain('The merge left conflicts in 2 files: client.js, lib/dates.js.')
    expect(notice.conflicts).toContain('one side deleted and the other changed')

    expect(describeBlueprintProposal(merge({ conflictPaths: ['client.js'] }), { changesFiles: true }).conflicts)
      .toContain('The merge left conflicts in 1 file: client.js.')
  })

  it('counts the conflicted files it does not name', () => {
    const conflictPaths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => `${name}.js`)
    expect(describeBlueprintProposal(merge({ conflictPaths }), { changesFiles: true }).conflicts)
      .toContain('The merge left conflicts in 7 files: a.js, b.js, c.js, d.js, e.js and 2 more.')
  })

  it('warns that a merge over a guessed base may have undone the user’s work', () => {
    for (const kind of ['fastForward', 'merge'] as const) {
      const notice = describeBlueprintProposal(merge({ kind, unverifiedBase: true }), { changesFiles: true })
      expect(notice.warning).toContain('share no history')
      expect(notice.warning).toContain('undone without a conflict being reported')
    }
  })

  it('does not warn of a guessed base where no file changes', () => {
    const notice = describeBlueprintProposal(merge({ unverifiedBase: true }), { changesFiles: false })
    expect(notice.warning).toBeUndefined()
  })

  it('lists the bindings the gadget lacks, by name', () => {
    const missingBindings: BlueprintMerge['missingBindings'] = {
      WEATHER: {
        type: 'gatekeeper',
        title: 'Weather service',
        description: 'Forecasts for the trip.',
        gatekeeperName: 'weather',
        typeUrlPattern: 'https://weather.example/*',
      },
      CALENDAR: {
        type: 'gatekeeper',
        title: '',
        description: '',
        gatekeeperName: 'calendar',
        typeUrlPattern: 'https://calendar.example/*',
      },
    }
    const notice = describeBlueprintProposal(merge({ kind: 'fastForward', missingBindings }), { changesFiles: true })
    expect(notice.missingBindings).toEqual([
      { name: 'CALENDAR', title: 'CALENDAR', description: '' },
      { name: 'WEATHER', title: 'Weather service', description: 'Forecasts for the trip.' },
    ])
    // Nothing starts an agent for a fast-forward, so wiring them is left to be asked for.
    expect(notice.missingBindingsHint).toBe('Ask in this chat to have them set up.')

    // The agent that reviews a merge is asked to wire them itself.
    expect(describeBlueprintProposal(merge({ missingBindings }), { changesFiles: true }).missingBindingsHint)
      .toBeUndefined()
    expect(describeBlueprintProposal(merge(), { changesFiles: true }).missingBindings).toEqual([])
  })
})

const changes = (over: Partial<Extract<AiChatMessage, { type: 'changes' }>>): AiChatMessage => ({
  chatId: 1,
  sequence: 0,
  timestamp: new Date(0),
  author: { type: 'user', id: 'dev', name: 'Dev' },
  type: 'changes',
  ...over,
})

describe('appliedBlueprintMerges', () => {
  it('is the proposals a person applied', () => {
    expect(appliedBlueprintMerges(changes({ blueprintMerges: [merge()] }))).toEqual([merge()])
    expect(appliedBlueprintMerges(changes({}))).toEqual([])
  })

  // That entry belongs to the gadget's creation, which has a card of its own.
  it('leaves out the entry the agent records when it creates a gadget from a blueprint', () => {
    const created = changes({
      author: { type: 'agent', id: 'model', name: 'Model' },
      blueprintMerges: [merge({ kind: 'fastForward' })],
    })
    expect(appliedBlueprintMerges(created)).toEqual([])
  })
})

describe('proposalMessageCount', () => {
  it('is one unless the change was split', () => {
    expect(proposalMessageCount([])).toBe(1)
    expect(proposalMessageCount([merge()])).toBe(1)
    expect(proposalMessageCount([merge({ messageCount: 3 })])).toBe(3)
  })
})
