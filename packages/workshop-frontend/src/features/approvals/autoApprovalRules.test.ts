import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { ADMIN_AGENT_ACTIONS } from '@gadgets/workshop-shared/admin-agent'
import {
  blockedBy, canOfferAlwaysApprove, couldBeAutoApproved, isAutoApproved, mayApplyWhileRestricted,
} from './autoApprovalRules'
import type { PendingChange } from './pendingChangeGroups'

const APPEND = { tag: 'append', label: 'Append a slide' }
const NOTE = ADMIN_AGENT_ACTIONS.issueReportNote.kind
const REPLY = ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind

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

/**
 * Rules covering every tag in `tags` on connection 1. Unrestricted, the kernel lets a rule apply
 * every kind; with `appliesUnderLatch`, the workspace is restricted and it lets one apply only
 * those tags, on connection 1.
 */
function rules(tags: string[], appliesUnderLatch?: string[]) {
  return {
    known: true,
    isEnabled: (gatekeeperId: number, tag: string) => gatekeeperId === 1 && tags.includes(tag),
    applies: (gatekeeperId: number, tag: string) => appliesUnderLatch === undefined ||
      (gatekeeperId === 1 && appliesUnderLatch.includes(tag)),
    restricted: appliesUnderLatch !== undefined,
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

  it('applies under the restricted latch only a kind the kernel says a rule applies', () => {
    const latched = rules(['append', NOTE.tag, REPLY.tag], [NOTE.tag])

    expect(isAutoApproved(request(1, { actionKind: NOTE }), latched)).toBe(true)
    expect(isAutoApproved(request(1, { actionKind: REPLY }), latched)).toBe(false)
    expect(isAutoApproved(request(1), latched)).toBe(false)
    // The kernel's answer is for a connection: the same kind elsewhere is held.
    expect(isAutoApproved(request(1, { gatekeeperId: 2, actionKind: NOTE }), latched)).toBe(false)
    // An answer nobody has read is no answer.
    expect(isAutoApproved(request(1, { actionKind: NOTE }), rules([NOTE.tag], []))).toBe(false)
  })
})

describe('couldBeAutoApproved', () => {
  it('needs no rule, only a kind a rule could apply', () => {
    expect(couldBeAutoApproved(request(1), rules([]))).toBe(true)
    expect(couldBeAutoApproved(request(1, { autoApprovable: false }), rules([]))).toBe(false)
    expect(couldBeAutoApproved(request(1, { actionKind: undefined }), rules([]))).toBe(false)
  })

  it('says so under the restricted latch only for a kind the kernel says a rule applies', () => {
    const latched = rules([], [NOTE.tag])

    expect(couldBeAutoApproved(request(1, { actionKind: NOTE }), latched)).toBe(true)
    expect(couldBeAutoApproved(request(1, { actionKind: REPLY }), latched)).toBe(false)
    expect(couldBeAutoApproved(request(1), latched)).toBe(false)
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

  it('offers under the restricted latch only a kind the kernel says a rule applies', () => {
    const latched = rules([], [NOTE.tag])

    expect(canOfferAlwaysApprove(request(1, { actionKind: NOTE }), latched)).toBe(true)
    expect(canOfferAlwaysApprove(request(1, { actionKind: REPLY }), latched)).toBe(false)
    expect(canOfferAlwaysApprove(request(1), latched)).toBe(false)
    // Its rule is on already.
    expect(canOfferAlwaysApprove(request(1, { actionKind: NOTE }), rules([NOTE.tag], [NOTE.tag])))
      .toBe(false)
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

  it('names an older request whose kind does not apply under the latch as what holds one that does', () => {
    // Both rules are on, and the kernel applies only the note: the reply ahead of it is a
    // manual gate, where the drain stops.
    const latched = rules([NOTE.tag, REPLY.tag], [NOTE.tag])
    const reply = request(1, { actionKind: REPLY })
    const note = request(2, { actionKind: NOTE })

    expect(blockedBy(note, [reply, note], latched)?.id).toBe(1)
    expect(blockedBy(reply, [reply, note], latched)).toBeUndefined()
  })
})

describe('mayApplyWhileRestricted', () => {
  const kindOf = (tag: string | undefined) =>
    mayApplyWhileRestricted(request(1, { actionKind: tag === undefined ? undefined : { tag, label: tag } }))

  it('is true for the kinds the kernel\'s table lets a rule apply under the latch', () => {
    expect(kindOf(ADMIN_AGENT_ACTIONS.issueReportNote.kind.tag)).toBe(true)
    expect(kindOf(ADMIN_AGENT_ACTIONS.issueReportStatus.kind.tag)).toBe(true)
    expect(kindOf(ADMIN_AGENT_ACTIONS.issueReportAssignment.kind.tag)).toBe(true)
  })

  it('is false for every other kind of the admin gatekeeper, another vendor\'s, and none', () => {
    expect(kindOf(ADMIN_AGENT_ACTIONS.issueReportReply.kind.tag)).toBe(false)
    expect(kindOf(ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind.tag)).toBe(false)
    expect(kindOf(ADMIN_AGENT_ACTIONS.workspaceWriteRequest.kind.tag)).toBe(false)
    expect(kindOf(ADMIN_AGENT_ACTIONS.contentAccessRequest.kind.tag)).toBe(false)
    expect(kindOf('append')).toBe(false)
    expect(kindOf(undefined)).toBe(false)
  })
})
