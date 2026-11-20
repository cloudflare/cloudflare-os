import { describe, expect, it } from 'vitest'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import type { ActionEntry } from '@/workspaces/activity/activityEntries'
import { approvalsWords, asksOfAutomations } from './automationAsks'
import type { Automation } from './automations'

const automation = (id: number, gadgetId: number): Automation => ({
  key: `w/${id}`,
  workspaceId: 'w',
  kind: 'event',
  hook: { id, gatekeeperId: 1, gadgetId, description: { title: `Hook ${id}`, description: '' }, enabled: true } as BoundHookInfo,
})
const ask = (id: number, gatekeeperId?: number) => ({
  id,
  type: 'action',
  gatekeeperId,
  resourceTitle: 'Thing',
  createdAt: new Date(Date.UTC(2026, 10, 20, 12, 60 - id)),
  state: 'pending',
  description: { title: `Ask ${id}`, description: '', implementsRevert: false, autoApprovable: true },
}) as ActionEntry

describe('asksOfAutomations', () => {
  const connections = new Map([[10, new Set([100])], [20, new Set([100, 200])], [30, new Set([300])]])
  const automations = [automation(1, 10), automation(2, 30), automation(3, 30)]

  it('puts each ask down to the one automation whose gadget is bound to its connection, oldest first', () => {
    const { byAutomation } = asksOfAutomations(automations, [ask(1, 100), ask(2, 100)], (id) => connections.get(id))
    expect([...byAutomation].map(([key, asks]) => [key, asks.map(({ id }) => id)])).toEqual([['w/1', [2, 1]]])
  })

  it('leaves unmatched what no automation, or several, could have asked, and what names no connection', () => {
    const { byAutomation, unmatched } = asksOfAutomations(automations, [ask(1, 300), ask(2, 999), ask(3)], (id) => connections.get(id))
    expect(byAutomation.size).toBe(0)
    expect(unmatched.map(({ id }) => id)).toEqual([3, 2, 1])
  })

  it('says how many wait', () => {
    expect([approvalsWords(1), approvalsWords(3)]).toEqual(['Needs approval', '3 approvals'])
  })
})
