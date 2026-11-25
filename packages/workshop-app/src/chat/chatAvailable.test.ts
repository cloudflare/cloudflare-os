import { describe, expect, it } from 'vitest'
import type { BoundHookInfo, GadgetBindingInfo, OutputSummary } from '@gadgets/workshop-shared/api'
import { availableTo } from './chatAvailable'
import type { ChatContext } from './chatContext'
import type { HookItem, OutputItem } from './chatItems'

const output = (workpieceId: number, title: string, patch: Partial<OutputItem> = {}): OutputItem =>
  ({ kind: 'output', id: workpieceId, key: `output:${workpieceId}`, workpieceId, title, type: 'gadget', draft: false, ...patch })
const summary = (workpieceId: number, title: string): OutputSummary =>
  ({ workspaceId: 'ws', workpieceId, title, workspaceTitle: 'Team', created: new Date(0), lastActive: new Date(0) })
const hookItem = (hookId: number | undefined): HookItem => ({ kind: 'hook', id: 1, key: `hook:${hookId}`, hookId, title: `Chat hook ${hookId}`, description: '', enabled: true })
const hook = (id: number): BoundHookInfo =>
  ({ id, gatekeeperId: 1, gadgetId: 2, description: { title: `Hook ${id}`, description: '' }, enabled: true })
const binding = (target: number, vendorId: string | undefined, resourceTitle: string, kind?: GadgetBindingInfo['kind']): GadgetBindingInfo =>
  ({ name: `b${target}`, target, vendorId, resourceTitle, kind })
const chat = (patch: Partial<ChatContext> = {}): ChatContext => ({ outputs: [], hooks: [], files: [], connectors: [], ...patch })

describe('availableTo', () => {
  it('lists the whole library, the chat’s drafts and worktrees first', () => {
    const own = chat({ outputs: [output(9, 'Draft', { draft: true }), output(4, 'Branch', { type: 'worktree' }), output(1, 'Report')] })
    const available = availableTo(own, { library: [summary(1, 'Report'), summary(2, 'Budget')], bindings: [] })
    expect(available.outputs.map(({ title }) => title)).toEqual(['Draft', 'Branch', 'Report', 'Budget'])
  })

  it('keeps what the chat made until the library is read', () => {
    const own = chat({ outputs: [output(1, 'Report')] })
    expect(availableTo(own, { bindings: [] }).outputs.map(({ title }) => title)).toEqual(['Report'])
  })

  it('lists the workspace’s automations, newest first, with one the chat set up since and none it deleted', () => {
    const own = chat({ hooks: [hookItem(7), hookItem(3), hookItem(undefined)] })
    const available = availableTo(own, { hooks: [hook(3), hook(5)], bindings: [] })
    expect(available.hooks.map(({ title }) => title)).toEqual(['Chat hook 7', 'Hook 5', 'Hook 3'])
  })

  it('lists what the gadgets reach, each once, with its kind where known, and anything else the chat went through', () => {
    const own = chat({ connectors: [{ key: 'drive:Notes', vendorId: 'drive', title: 'Notes' }, { key: 'drive:Q3 plan', vendorId: 'drive', title: 'Q3 plan' }] })
    const available = availableTo(own, {
      bindings: [binding(1, 'drive', 'Q3 plan', 'gatekeeper'), binding(2, 'drive', 'Q3 plan'), binding(3, undefined, 'Claude', 'aiModel'), binding(4, 'skills', 'Skills', 'ambient')],
      reaches: new Map([[1, { resourceTypeId: 'doc' }]]),
    })
    expect(available.connectors.map(({ key, resourceTypeId }) => [key, resourceTypeId])).toEqual([['drive:Q3 plan', 'doc'], ['skills:Skills', undefined], ['drive:Notes', undefined]])
  })
})
