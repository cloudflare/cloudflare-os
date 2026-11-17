import { describe, expect, it } from 'vitest'
import type { PreApprovableAction } from '@gadgets/workshop-shared/api'
import { standingApprovals, withApproval } from './standingApprovals'

const offered = (gatekeeperId: number, resourceTitle: string, tag: string, alreadyEnabled = false): PreApprovableAction => ({
  gatekeeperId,
  resourceTitle,
  actionKind: { tag, label: `Label of ${tag}` },
  alreadyEnabled,
})

const rule = (gatekeeperId: number, tag: string) => ({ gatekeeperId, actionKind: { tag, label: `Label of ${tag}` } })

describe('standingApprovals', () => {
  it('lists what a workspace’s connections offer, off until a rule says otherwise', () => {
    expect(standingApprovals([offered(1, 'Slack', 'post')], [])).toEqual([
      { key: '1:post', gatekeeperId: 1, actionKind: { tag: 'post', label: 'Label of post' }, connection: 'Slack', vendorId: undefined, enabled: false, orphaned: false },
    ])
  })

  it('has a kind on when the catalog says it is', () => {
    expect(standingApprovals([offered(1, 'Slack', 'post', true)], [])[0].enabled).toBe(true)
  })

  it('has a kind on when a rule says it is, listed once', () => {
    const approvals = standingApprovals([offered(1, 'Slack', 'post')], [rule(1, 'post')])
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ enabled: true, orphaned: false })
  })

  it('tells the same kind on two connections apart', () => {
    const approvals = standingApprovals([offered(1, 'Slack', 'post'), offered(2, 'Slack (work)', 'post')], [rule(2, 'post')])
    expect(approvals.map(({ key, enabled }) => [key, enabled])).toEqual([['1:post', false], ['2:post', true]])
  })

  it('keeps a rule nothing offers any more, so that it can be taken back', () => {
    const approvals = standingApprovals([offered(1, 'Slack', 'post')], [rule(7, 'send')])
    expect(approvals.at(-1)).toMatchObject({ key: '7:send', connection: '', enabled: true, orphaned: true })
  })

  it('orders by connection, then by what the kind is called, with what is no longer offered last', () => {
    const approvals = standingApprovals(
      [offered(2, 'Slack', 'react'), offered(1, 'Gmail', 'send'), offered(2, 'Slack', 'post')],
      [rule(9, 'archive')],
    )
    expect(approvals.map(({ key }) => key)).toEqual(['1:send', '2:post', '2:react', '9:archive'])
  })
})

describe('withApproval', () => {
  it('switches the one named and leaves the rest as they are', () => {
    const approvals = standingApprovals([offered(1, 'Slack', 'post'), offered(1, 'Slack', 'react')], [])
    const next = withApproval(approvals, '1:react', true)
    expect(next.map(({ enabled }) => enabled)).toEqual([false, true])
    expect(next[0]).toBe(approvals[0])
  })
})
