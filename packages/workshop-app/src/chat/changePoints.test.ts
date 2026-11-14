import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { changePoints, nameGadgets } from './changePoints'
import { toChatFeed } from './chatItems'
import { agent, history, user, VIEWER, type MessageSource } from './mock/scenario'

const GRACE: AiChatAuthorInfo = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' }

// Kept changes to gadget 4: made by them when `previousCommit` is null, and from before merges
// recorded it when it is `unrecorded`.
const kept = (previousCommit: string | null = 'c0', author = VIEWER): MessageSource => (sequence: number) => ({
  type: 'merge',
  mergeThrough: sequence - 1,
  commits: [{ gadgetId: 4, commitId: `c${sequence}`, ...(previousCommit === 'unrecorded' ? {} : { previousCommit }) }],
  epochBoundary: true,
  author,
})
const restored = (from: number, to: 'before' | 'after'): MessageSource => () => ({
  type: 'restore',
  from,
  to,
  commits: [{ gadgetId: 4, commitId: 'r', previousCommit: 'c' }],
  author: VIEWER,
})
const points = (...sources: Parameters<typeof history>[0]) => changePoints(history(sources), VIEWER.id)

describe('changePoints', () => {
  it('offers undoing the newest kept changes on the answer that ended their turn, and going back to older ones', () => {
    const { answers, marks } = points(user('make it'), agent({ text: 'Made.' }), kept(), user('change it'), agent({ text: 'Changed.' }), kept())
    expect([...answers]).toEqual([
      [1, { sequence: 2, to: 'after', action: 'restore', deletes: [] }],
      [4, { sequence: 5, to: 'before', action: 'undo', deletes: [] }],
    ])
    expect(marks.size).toBe(0)
  })

  it('names what undoing would remove: the gadgets the changes made', () => {
    const { answers } = points(user('make it'), agent({ text: 'Made.' }), kept(null))
    expect(answers.get(1)).toMatchObject({ action: 'undo', deletes: [4] })
  })

  it('offers nothing where there is nothing to go back to, or no record of what was replaced', () => {
    expect(points(user('make it'), agent({ text: 'Made.' }), kept('unrecorded')).answers.size).toBe(0)
    // A turn that said nothing has no answer to offer it on.
    expect(points(user('make it'), agent({ text: '' }), kept()).answers.size).toBe(0)
  })

  it('offers someone else’s, and every restore, on its own line, the newest restore of an undo as a redo', () => {
    const { answers, marks } = points(user('make it'), agent({ text: 'Made.' }), kept('c0', GRACE), restored(2, 'before'))
    expect(answers.size).toBe(0)
    expect([...marks]).toEqual([
      [2, { sequence: 2, to: 'after', action: 'restore', deletes: [] }],
      [3, { sequence: 3, to: 'before', action: 'redo', deletes: [] }],
    ])
  })

  it('reaches the feed: on the answer, and on a restore’s line, which says when it redid', () => {
    const feed = toChatFeed(history([user('make it'), agent({ text: 'Made.' }), kept(), restored(2, 'before'), restored(3, 'before')]), { viewerId: VIEWER.id })
    const rows = [...feed.items, ...feed.pinned]
    expect(rows.find((row) => row.kind === 'assistant')).toMatchObject({ goBack: { action: 'restore' } })
    expect(rows.filter((row) => row.kind === 'divider').map(({ label, goBack }) => [label, goBack?.action])).toEqual([
      ['You undid changes', 'restore'],
      ['You redid changes', 'undo'],
    ])
  })
})

describe('nameGadgets', () => {
  it('names them by title, or plainly when one has none known', () => {
    expect(nameGadgets(['Tip Jar'])).toBe('“Tip Jar”')
    expect(nameGadgets(['Tip Jar', 'Notes'])).toBe('“Tip Jar” and “Notes”')
    expect(nameGadgets([undefined])).toBe('this gadget')
    expect(nameGadgets(['Tip Jar', undefined])).toBe('these gadgets')
  })
})
