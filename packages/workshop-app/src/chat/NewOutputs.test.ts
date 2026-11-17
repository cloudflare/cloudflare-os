import { describe, expect, it } from 'vitest'
import type { ChatFeed, OutputItem } from './chatItems'
import { NewOutputs } from './NewOutputs'

const output = (id: number) => ({ kind: 'output', key: `output:${id}`, id, workpieceId: id, title: `Output ${id}`, type: 'gadget', draft: true }) as OutputItem
const feed = (items: OutputItem[], pinned: OutputItem[]): Pick<ChatFeed, 'items' | 'pinned'> => ({ items, pinned })

describe('NewOutputs', () => {
  it('takes nothing the chat had made by the time it was opened', () => {
    const made = new NewOutputs()
    expect(made.take(feed([output(1)], [output(2)]))).toBeUndefined()
    expect(made.take(feed([output(1)], [output(2)]))).toBeUndefined()
  })

  it('takes what is made after, once', () => {
    const made = new NewOutputs()
    made.take(feed([], []))
    expect(made.take(feed([], [output(1)]))?.workpieceId).toBe(1)
    expect(made.take(feed([], [output(1)]))).toBeUndefined()
  })

  it('takes the latest of several made at once', () => {
    const made = new NewOutputs()
    made.take(feed([], []))
    expect(made.take(feed([], [output(1), output(2)]))?.workpieceId).toBe(2)
  })

  it('does not take one again when its turn ends and it joins the conversation', () => {
    const made = new NewOutputs()
    made.take(feed([], []))
    made.take(feed([], [output(1)]))
    expect(made.take(feed([output(1)], []))).toBeUndefined()
  })

  it('does not take what comes in with earlier history', () => {
    const made = new NewOutputs()
    made.take(feed([output(5)], []))
    expect(made.take(feed([output(1), output(5)], []))).toBeUndefined()
  })
})
