import { describe, expect, it } from 'vitest'
import { toChatFeed, type ActionItem, type ChatItem } from './chatItems'
import { fileChanges, pendingActions, pendingCount, pendingGroups } from './pendingGroups'
import { decideInOrder } from './usePendingDecisions'
import { action, history, VIEWER } from './mock/scenario'

const DOC = { id: 'doc-1', title: 'Weekly notes', role: 'edited' as const, url: 'https://docs.google.com/document/d/doc-1/edit' }
const OTHER = { ...DOC, id: 'doc-2', title: 'Budget', url: 'https://docs.google.com/document/d/doc-2/edit' }
const rows = (...sources: Parameters<typeof history>[0]): ChatItem[] => {
  const { items, pinned } = toChatFeed(history(sources), { viewerId: VIEWER.id })
  return [...items, ...pinned]
}
const actionsOf = (items: ChatItem[]) => items.filter((item): item is ActionItem => item.kind === 'action')

describe('pendingGroups', () => {
  it('groups what waits by the file it changes, in the order each was first asked for', () => {
    const waiting = pendingActions(rows(
      action({ title: 'Append', subject: DOC }),
      action({ title: 'Create issue' }),
      action({ title: 'Append', subject: OTHER }),
      action({ title: 'Append', subject: DOC }),
      action({ title: 'Done', subject: DOC, state: 'approved' }),
    ))
    const groups = pendingGroups(waiting)
    expect(groups.map(({ target, actions }) => [target.title, actions.length])).toEqual([['Weekly notes', 2], ['Jira · Platform board', 1], ['Budget', 1]])
    expect(groups[0].target.fileKind).toBe('document')
    expect(groups[0].actions[0].actionId).toBeLessThan(groups[0].actions[1].actionId)
    expect(groups.map(pendingCount)).toEqual(['2 changes', '1 request', '1 change'])
  })

  it('says whether any of a group holds the agent', () => {
    const [group] = pendingGroups(pendingActions(rows(action({ title: 'Append', subject: DOC }), action({ title: 'Append', subject: DOC, awaitDecision: true }))))
    expect(group.holdsAgent).toBe(true)
  })
})

describe('fileChanges', () => {
  it('finds what a chat asks of one file: what waits, and what was decided, each of a folded run', () => {
    const items = rows(
      action({ title: 'Append', subject: DOC, state: 'approved' }),
      action({ title: 'Append', subject: DOC, state: 'approved' }),
      action({ title: 'Replace', subject: DOC, state: 'denied' }),
      action({ title: 'Append', subject: OTHER }),
      action({ title: 'Append', subject: DOC }),
    )
    const all = actionsOf(items)
    const { waiting, decided } = fileChanges(items, all[0].target.gatekeeperId!, DOC.id)
    expect(waiting.map(({ title }) => title)).toEqual(['Append'])
    // The two approvals fold into one row, which still counts each.
    expect(all[0].runOf).toHaveLength(2)
    expect([...decided.values()]).toEqual(['approved', 'approved', 'rejected'])
  })
})

describe('decideInOrder', () => {
  const three = actionsOf(rows(action({ title: 'One', subject: DOC }), action({ title: 'Two', subject: DOC }), action({ title: 'Three', subject: DOC })))
  const ids = three.map(({ actionId }) => actionId)

  it('approves oldest first and denies newest first, saying how far it has got', async () => {
    const order: number[] = []
    const progress: number[] = []
    const decide = async (id: number) => void order.push(id)
    expect(await decideInOrder(three.toReversed(), 'approve', { decide, approveCreation: async () => true }, ({ done }) => progress.push(done))).toBeUndefined()
    expect(order).toEqual(ids)
    expect(progress).toEqual([0, 1, 2])
    order.length = 0
    await decideInOrder(three, 'deny', { decide, approveCreation: async () => true })
    expect(order).toEqual(ids.toReversed())
  })

  it('stops at the first that fails, naming it, and leaves the rest', async () => {
    const order: number[] = []
    const decide = async (id: number) => {
      if (id === ids[1]) throw new Error('The doc was deleted')
      order.push(id)
    }
    expect(await decideInOrder(three, 'approve', { decide, approveCreation: async () => true })).toBe('Couldn’t approve “Two”: The doc was deleted')
    expect(order).toEqual([ids[0]])
  })

  it('stops at a creation that asks where to make it, before what builds on it', async () => {
    const [create, edit] = actionsOf(rows(action({ title: 'Create', creation: true }), action({ title: 'Edit' })))
    const decided: number[] = []
    const asked: number[] = []
    const problem = await decideInOrder([edit, create], 'approve', {
      decide: async (id) => void decided.push(id),
      approveCreation: async ({ actionId }) => (asked.push(actionId), false),
    })
    expect(problem).toBeUndefined()
    expect(asked).toEqual([create.actionId])
    expect(decided).toEqual([])
  })
})
