import { describe, expect, it } from 'vitest'
import { AUTO_APPLY_GRACE_MS, autoApplying, type Draft, type DraftGroup } from './drafts'

const NOW = 1_000_000
const draft = (id: number, { autoApprovable = true, age = 0, creation = false } = {}) => ({
  id, type: 'action', state: 'pending', gatekeeperId: 4, resourceTitle: 'Budget',
  createdAt: new Date(NOW - age), ...(creation ? { creation: true } : {}),
  description: { title: `Edit ${id}`, description: '', implementsRevert: false, autoApprovable },
}) as Draft
const group = (drafts: Draft[]): DraftGroup =>
  ({ key: 'chat:4:', gatekeeperId: 4, title: 'Budget', kind: 'spreadsheet', drafts, holdsAgent: false })

describe('autoApplying', () => {
  it('holds back fresh drafts Auto applies, up to the first that needs a person', () => {
    expect(autoApplying([group([draft(1), draft(2), draft(3, { autoApprovable: false }), draft(4)])], NOW))
      .toEqual(new Set([1, 2]))
  })

  it('shows a draft still waiting once it has had time to apply, and never holds back a creation', () => {
    expect(autoApplying([group([draft(1, { age: AUTO_APPLY_GRACE_MS })])], NOW)).toEqual(new Set())
    expect(autoApplying([group([draft(1, { creation: true }), draft(2)])], NOW)).toEqual(new Set())
  })
})
