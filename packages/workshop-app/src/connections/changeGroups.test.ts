import { describe, expect, it } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { kindLabel } from '@/blocks/ChangeDefaultsList'
import { changeGroups } from './changeGroups'
import { rulesOf } from './useWorkspaceRules'

const resource = (urlPattern: string, kinds: Array<[string, boolean]>): SupportedResource => ({
  urlPattern,
  title: urlPattern,
  description: '',
  actionKinds: kinds.map(([tag, autoApprovable]) => ({ kind: { tag, label: `${tag} label` }, autoApprovable })),
} as SupportedResource)

describe('changeGroups', () => {
  it('lists every kind under the first kind of thing that has it, leaving out things with none', () => {
    const groups = changeGroups(
      [resource('doc', [['edit', true], ['share', true]]), resource('bigquery', []), resource('folder', [['share', true], ['move', true]])],
      new Set(['share']),
    )
    expect(groups.map(({ key, changes }) => [key, changes.map(({ kind, automatic }) => [kind.tag, automatic])])).toEqual([
      ['doc', [['edit', false], ['share', true]]],
      ['folder', [['move', false]]],
    ])
  })

  it('keeps a kind that cannot go ahead on its own asking, whatever was chosen', () => {
    const [gmail] = changeGroups([resource('gmail', [['label', true], ['send', false]])], new Set(['send']))
    expect(gmail.changes).toEqual([
      { kind: { tag: 'label', label: 'label label' }, autoApprovable: true, automatic: false },
      { kind: { tag: 'send', label: 'send label' }, autoApprovable: false, automatic: false },
    ])
  })

  it('names the workspaces that let a kind go ahead only where the service asks first', () => {
    const [doc] = changeGroups([resource('doc', [['edit', true], ['share', true]])], new Set(['share']), new Map([['edit', ['Trips']], ['share', ['Trips']]]))
    expect(doc.changes.map(({ alsoIn }) => alsoIn)).toEqual([['Trips'], undefined])
  })
})

describe('rulesOf', () => {
  const entry = (gatekeeperId: number, tag: string, vendorId: string | undefined, alreadyEnabled: boolean) =>
    ({ gatekeeperId, resourceTitle: '', vendorId, actionKind: { tag, label: tag }, alreadyEnabled })

  it('keeps the service’s rules that are on, once each', () => {
    const workspace = { id: 'w', title: 'Trips' }
    expect(rulesOf([entry(5, 'edit', 'Google', true), entry(5, 'edit', 'google', true), entry(5, 'share', 'google', false), entry(6, 'post', 'slack', true), entry(7, 'edit', undefined, true)], 'google', workspace))
      .toEqual([{ workspaceId: 'w', workspaceTitle: 'Trips', gatekeeperId: 5, tag: 'edit' }])
  })
})

describe('kindLabel', () => {
  it('splits what a change is from how far it reaches, at “, in ”', () => {
    expect(kindLabel('Adding, copying and reordering slides, in any presentation this connection reaches'))
      .toEqual({ title: 'Adding, copying and reordering slides', reach: 'In any presentation this connection reaches' })
    expect(kindLabel('Drive comments')).toEqual({ title: 'Drive comments' })
  })
})
