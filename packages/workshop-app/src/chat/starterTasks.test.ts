import { describe, expect, it } from 'vitest'
import { pickStarterTasks, STARTER_TASKS, STARTERS_SHOWN } from './starterTasks'

describe('pickStarterTasks', () => {
  it('offers a few of the tasks, each once', () => {
    const picked = pickStarterTasks()
    expect(picked).toHaveLength(STARTERS_SHOWN)
    expect(new Set(picked.map(({ id }) => id)).size).toBe(STARTERS_SHOWN)
    for (const task of picked) expect(STARTER_TASKS).toContain(task)
  })

  it('can offer any of them, as it draws afresh each time', () => {
    // Each swapped in turn with the first, which turns them round by one: the first is not shown.
    expect(pickStarterTasks(STARTER_TASKS, 3, () => 0)).toEqual(STARTER_TASKS.slice(1, 4))
    // Every draw at the top swaps each with itself, which leaves them in order.
    expect(pickStarterTasks(STARTER_TASKS, STARTER_TASKS.length, () => 0.999)).toEqual(STARTER_TASKS)
  })

  it('offers them all when there are fewer than it would show', () => {
    expect(pickStarterTasks(STARTER_TASKS.slice(0, 2))).toHaveLength(2)
  })
})
