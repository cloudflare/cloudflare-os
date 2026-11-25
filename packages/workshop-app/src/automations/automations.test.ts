import { describe, expect, it } from 'vitest'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import { automationsOf, setUpIn } from './automations'

const boundHook = (id: number, more: Partial<BoundHookInfo> = {}): BoundHookInfo => ({
  id, gatekeeperId: 50, gadgetId: 2, description: { title: `Hook ${id}`, description: 'Runs.' }, enabled: true, ...more,
})

describe('automationsOf', () => {
  it('lists a workspace’s hooks newest first, keyed across workspaces', () => {
    expect(automationsOf('w', [boundHook(1), boundHook(3), boundHook(2)]).map(({ key }) => key)).toEqual(['w/3', 'w/2', 'w/1'])
  })
})

describe('a chat’s automations', () => {
  it('are the hooks bound from it', () => {
    const list = automationsOf('w', [boundHook(1, { chatId: 7 }), boundHook(2, { chatId: 8 }), boundHook(3, { chatId: 7 }), boundHook(4)])
    expect(list.filter(setUpIn(7)).map(({ hook }) => hook.id)).toEqual([3, 1])
  })
})
