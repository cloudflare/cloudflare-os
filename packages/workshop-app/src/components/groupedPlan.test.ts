import { describe, expect, it } from 'vitest'
import { planList, type PlanItem } from './groupedPlan'

const B = 24
const spacing = { boundary: B, touching: 12 }

// The list at rest: groups as strings of keys, such as 'ab|cd'.
const atRest = (groups: string): PlanItem[] =>
  groups.split('|').flatMap((keys, group, all) =>
    [...keys].map((key, at) => ({ id: key, key, ghost: false, group: `g${group}`, presence: 1, fades: false, gap: at < keys.length - 1 ? 0 : group < all.length - 1 ? B : 0 })))
const rows = (groups: Array<[string, string]>) => groups.flatMap(([group, keys]) => [...keys].map((key) => ({ key, group })))
const plan = (before: PlanItem[], after: Array<{ key: string; group: string }>) => planList(before, after, spacing, (key) => `${key}~`)
const brief = (planned: ReturnType<typeof plan>) => planned.map(({ id, change, gap }) => `${id} ${change} ${gap.from}>${gap.to}`)

describe('planList', () => {
  it('leaves rows where they are when nothing changed', () => {
    expect(brief(plan(atRest('ab|cd'), rows([['g0', 'ab'], ['g1', 'cd']])))).toEqual(['a stayed 0>0', 'b stayed 24>24', 'c stayed 0>0', 'd stayed 0>0'])
  })

  it('has a starred row shrink out of its group and grow in at the top of the starred one', () => {
    // Starred s, then today's c, x and d; x is starred.
    const planned = plan(atRest('s|cxd'), rows([['g0', 'xs'], ['g1', 'cd']]))
    expect(brief(planned)).toEqual(['x arrived 0>0', 's stayed 24>24', 'c stayed 0>0', 'x~ left 0>0', 'd stayed 0>0'])
    expect(planned[3].presence).toEqual({ from: 1, to: 0 })
  })

  it('opens and closes boundaries between rows that stay, as the groups fold differently', () => {
    // Today's x is starred, and the one left is folded into yesterday's c and d.
    const planned = plan(atRest('s|bx|cd'), rows([['g0', 'xs'], ['t', 'bcd']]))
    expect(brief(planned)).toEqual(['x arrived 0>0', 's stayed 24>24', 'b stayed 0>0', 'x~ left 24>0', 'c stayed 0>0', 'd stayed 0>0'])
  })

  it('only opens and closes boundaries when every group is known by another name after folding', () => {
    expect(brief(plan(atRest('s|ab|cd'), rows([['g0', 's'], ['t', 'abc'], ['u', 'd']])))).toEqual(['s stayed 24>24', 'a stayed 0>0', 'b stayed 24>0', 'c stayed 0>24', 'd stayed 0>0'])
  })

  it('grows a new group out of the one it arrives beside, then opens the boundary', () => {
    expect(brief(plan(atRest('ab'), rows([['s', 'b'], ['g0', 'a']])))).toEqual(['b arrived 0>24', 'a stayed 0>0', 'b~ left 0>0'])
  })

  it('shrinks a group of one away on its own, its boundaries closing to one', () => {
    const planned = plan(atRest('s|ab'), rows([['g1', 'asb']]))
    expect(brief(planned)).toEqual(['s~ left 24>0', 'a stayed 0>0', 's arrived 0>0', 'b stayed 0>0'])
    expect(planned[0].fades).toBe(true)
  })

  it('has a row moved within its group slide there, the room around the group kept', () => {
    expect(brief(plan(atRest('ab|c'), rows([['g0', 'ba'], ['g1', 'c']])))).toEqual(['b slid 0>0', 'a stayed 24>24', 'c stayed 0>0'])
  })

  it('takes up a row’s own copy when it comes back beside it', () => {
    const before = [...atRest('xs|cd')]
    // x was just starred: arriving at the top, its copy shrinking out after c.
    before[0] = { ...before[0], presence: 0.4 }
    before.splice(3, 0, { id: 'x~old', key: 'x', ghost: true, group: 'g1', presence: 0.6, fades: false, gap: 0 })
    const planned = plan(before, rows([['g0', 's'], ['g1', 'cxd']]))
    expect(brief(planned)).toEqual(['x~ left 0>0', 's stayed 24>24', 'c stayed 0>0', 'x returned 0>0', 'd stayed 0>0'])
    expect(planned[3].presence).toEqual({ from: 0.6, to: 1 })
  })
})
