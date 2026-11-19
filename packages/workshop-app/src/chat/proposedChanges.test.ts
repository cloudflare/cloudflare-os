import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, AiChatMessage, AiChatMessageBody } from '@gadgets/workshop-shared/api'
import { proposedChanges } from './proposedChanges'

const agent: AiChatAuthorInfo = { type: 'agent', id: 'a', name: 'Agent' }

type Changes = Extract<AiChatMessageBody, { type: 'changes' }>

const at = (sequence: number, body: AiChatMessageBody): AiChatMessage =>
  ({ chatId: 0, sequence, timestamp: new Date(0), author: agent, ...body }) as AiChatMessage
const changes = (sequence: number, extra: Omit<Changes, 'type'> = {}) => at(sequence, { type: 'changes', ...extra })
const merge = (sequence: number) => at(sequence, { type: 'merge', mergeThrough: sequence - 1, commits: [], epochBoundary: true })
const revert = (sequence: number, revertFrom: number) => at(sequence, { type: 'revert', revertFrom })

const binding = { addedBindings: [{ gadgetId: 1, name: 'JIRA', target: 9 }] }
const blueprint = (gadgetId: number): Pick<Changes, 'blueprintMerges'> => ({
  blueprintMerges: [{ gadgetId, blueprintId: 'docs', title: 'Docs', version: 1, commitId: 'c', kind: 'fastForward', conflictPaths: [] }],
})

describe('proposedChanges', () => {
  it('says what the changes make, change, give and bring in', () => {
    expect(proposedChanges([
      changes(1, { change: { 4: [] } }),
      changes(2, binding),
      changes(3, { ...blueprint(5), mainlineMerge: { conflictPaths: ['a.js'] } }),
    ], undefined)).toEqual({
      created: [],
      edited: [4],
      bindings: [{ gadgetId: 1, name: 'JIRA', target: 9 }],
      updates: [{ gadgetId: 5, title: 'Docs' }],
      mainline: true,
      conflicts: ['a.js'],
    })
  })

  it('says a gadget it makes once, with its blueprint’s release and code as part of it', () => {
    expect(proposedChanges([
      changes(1, { createdGadgets: [{ gadgetId: 3, title: 'Doc', bindingName: 'DOC' }], ...blueprint(3), change: { 3: [] } }),
      changes(2, { change: { 3: [] } }),
    ], undefined)).toMatchObject({ created: [{ gadgetId: 3, title: 'Doc' }], edited: [], updates: [] })
  })

  it('goes by what is still proposed: not what an earlier accept took, or a revert discarded', () => {
    expect(proposedChanges([changes(1, binding), merge(2), changes(3)], 2).bindings).toEqual([])
    expect(proposedChanges([changes(1), changes(2, binding), revert(3, 2), changes(4)], undefined).bindings).toEqual([])
  })
})
