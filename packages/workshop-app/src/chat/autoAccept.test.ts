import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { acceptsAlone, proposesOnlyCode } from './autoAccept'

const agent: AiChatAuthorInfo = { type: 'agent', id: 'a', name: 'Agent' }

const chat = (id: number, proposedChangeWorkpieces?: number[], activeAgent?: AiChatAuthorInfo): AiChatMetadata =>
  ({ id, title: 'Chat', started: new Date(0), lastActive: new Date(0), proposedChangeWorkpieces, activeAgent })

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

describe('acceptsAlone', () => {
  it('accepts a chat whose agent has stopped, in a workspace nobody else is in', () => {
    const shown = chat(0, [1])
    expect(acceptsAlone(shown, [shown, chat(1, [2])], false)).toBe(true)
  })

  it('leaves a chat with nothing proposed, or with its agent still working', () => {
    expect(acceptsAlone(chat(0, []), [], false)).toBe(false)
    expect(acceptsAlone(chat(0, [1], agent), [], false)).toBe(false)
  })

  it('leaves the changes in a shared workspace', () => {
    expect(acceptsAlone(chat(0, [1]), [], true)).toBe(false)
  })

  it('leaves the changes when another chat has changes waiting to the same gadget', () => {
    const shown = chat(0, [1, 2])
    expect(acceptsAlone(shown, [shown, chat(1, [2])], false)).toBe(false)
  })
})

describe('proposesOnlyCode', () => {
  it('accepts edits and gadgets the chat made, including one made from a blueprint', () => {
    expect(proposesOnlyCode([changes(1, { createdGadgets: [{ gadgetId: 3, title: 'Doc', bindingName: 'DOC' }], ...blueprint(3) }), changes(2)], undefined)).toBe(true)
  })

  it('leaves a binding for the user to grant', () => {
    expect(proposesOnlyCode([changes(1), changes(2, binding)], undefined)).toBe(false)
  })

  it('leaves a blueprint’s update to a gadget that was already there, and the latest accepted changes brought in', () => {
    expect(proposesOnlyCode([changes(1, blueprint(1))], undefined)).toBe(false)
    expect(proposesOnlyCode([changes(1, { mainlineMerge: { conflictPaths: [] } })], undefined)).toBe(false)
  })

  it('goes by what is still proposed: not what an earlier accept took, or a revert discarded', () => {
    expect(proposesOnlyCode([changes(1, binding), merge(2), changes(3)], 2)).toBe(true)
    expect(proposesOnlyCode([changes(1), changes(2, binding), revert(3, 2), changes(4)], undefined)).toBe(true)
  })
})
