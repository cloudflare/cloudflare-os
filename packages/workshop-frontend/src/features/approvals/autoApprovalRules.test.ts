import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { blockedBy, canOfferAlwaysApprove, isAutoApproved } from './autoApprovalRules'
import type { PendingChange } from './pendingChangeGroups'

const APPEND = { tag: 'append', label: 'Append a slide' }

function request(id: number, over: {
  gatekeeperId?: number
  autoApprovable?: boolean
  actionKind?: { tag: string, label: string }
  state?: ActionLogEntry['state']
} = {}): PendingChange {
  return {
    id,
    gatekeeperId: over.gatekeeperId ?? 1,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date('2026-11-11T00:00:00Z'),
    state: over.state ?? 'pending',
    type: 'action',
    origin: 'open-chat',
    description: {
      title: `Write ${id}`,
      description: '',
      implementsRevert: false,
      autoApprovable: over.autoApprovable ?? true,
      ...('actionKind' in over ? { actionKind: over.actionKind } : { actionKind: APPEND }),
    },
  } as PendingChange
}

/** Rules covering every tag in `tags` on connection 1. */
function rules(tags: string[], restricted = false) {
  return {
    isEnabled: (gatekeeperId: number, tag: string) => gatekeeperId === 1 && tags.includes(tag),
    restricted,
  }
}

describe('isAutoApproved', () => {
  it('needs the gatekeeper\'s verdict, a kind, and a rule for that kind', () => {
    expect(isAutoApproved(request(1), rules(['append']))).toBe(true)
    expect(isAutoApproved(request(1, { autoApprovable: false }), rules(['append']))).toBe(false)
    expect(isAutoApproved(request(1, { actionKind: undefined }), rules(['append']))).toBe(false)
    expect(isAutoApproved(request(1), rules([]))).toBe(false)
    // The rule is scoped to its connection, not to the kind alone.
    expect(isAutoApproved(request(1, { gatekeeperId: 2 }), rules(['append']))).toBe(false)
  })

  it('treats the restricted latch as disabling every rule', () => {
    expect(isAutoApproved(request(1), rules(['append'], true))).toBe(false)
  })
})

describe('canOfferAlwaysApprove', () => {
  it('offers only where enabling a rule would actually apply the request', () => {
    expect(canOfferAlwaysApprove(request(1), rules([]))).toBe(true)
    // A rule is already on, so the button would grant nothing new.
    expect(canOfferAlwaysApprove(request(1), rules(['append']))).toBe(false)
    // Not auto-approvable: a rule would leave it a manual gate anyway.
    expect(canOfferAlwaysApprove(request(1, { autoApprovable: false }), rules([]))).toBe(false)
    expect(canOfferAlwaysApprove(request(1, { actionKind: undefined }), rules([]))).toBe(false)
  })

  it('offers nothing while restricted, where no rule can apply', () => {
    expect(canOfferAlwaysApprove(request(1), rules([], true))).toBe(false)
  })
})

describe('blockedBy', () => {
  const covered = rules(['append'])

  it('names the oldest uncovered request ahead of it in the group', () => {
    const gate = request(2, { autoApprovable: false })
    const group = [request(1, { autoApprovable: false }), gate, request(3)]

    // The drain stops at the first manual gate, so the one at the head of the queue is the
    // reason, not the nearest one.
    expect(blockedBy(request(3), group, covered)?.id).toBe(1)
    expect(blockedBy(request(3), [gate, request(3)], covered)?.id).toBe(2)
  })

  it('ignores requests queued behind it', () => {
    // Nothing older gates it, and what came after is drained after it either way.
    expect(blockedBy(request(3), [request(3), request(4, { autoApprovable: false })], covered))
      .toBeUndefined()
  })

  it('says nothing about a request that no rule covers', () => {
    // It is not waiting on anything: the user is what it is waiting for.
    expect(blockedBy(request(2), [request(1, { autoApprovable: false })], rules([])))
      .toBeUndefined()
  })
})
