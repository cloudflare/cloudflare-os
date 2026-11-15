import { describe, expect, it } from 'vitest'
import type { PreApprovableAction } from '@gadgets/workshop-shared/api'
import { kindLabel } from '@/blocks/ChangeRulesGroup'
import { connectionsOf } from './useChangeRules'

const entry = (gatekeeperId: number, tag: string, vendorId: string | undefined, alreadyEnabled = false): PreApprovableAction =>
  ({ gatekeeperId, resourceTitle: `Connection ${gatekeeperId}`, vendorId, actionKind: { tag, label: `${tag} label` }, alreadyEnabled })

describe('connectionsOf', () => {
  it('keeps the service’s connections, each with its kinds in order, and whether each is automatic', () => {
    const catalog = [entry(5, 'edit', 'google'), entry(3, 'post', 'slack'), entry(5, 'comment', 'Google', true), entry(9, 'edit', 'google')]
    expect(connectionsOf(catalog, 'google')).toEqual([
      { gatekeeperId: 5, title: 'Connection 5', kinds: [{ tag: 'edit', label: 'edit label', automatic: false }, { tag: 'comment', label: 'comment label', automatic: true }] },
      { gatekeeperId: 9, title: 'Connection 9', kinds: [{ tag: 'edit', label: 'edit label', automatic: false }] },
    ])
  })

  it('lists a kind two actions share once, and leaves out connections with no service', () => {
    expect(connectionsOf([entry(5, 'edit', 'google'), entry(5, 'edit', 'google'), entry(6, 'edit', undefined)], 'google'))
      .toEqual([{ gatekeeperId: 5, title: 'Connection 5', kinds: [{ tag: 'edit', label: 'edit label', automatic: false }] }])
  })
})

describe('kindLabel', () => {
  it('splits what a change is from how far it reaches, at “, in ”', () => {
    expect(kindLabel('Adding, copying and reordering slides, in any presentation this connection reaches'))
      .toEqual({ title: 'Adding, copying and reordering slides', reach: 'In any presentation this connection reaches' })
    expect(kindLabel('Drive comments')).toEqual({ title: 'Drive comments' })
  })
})
