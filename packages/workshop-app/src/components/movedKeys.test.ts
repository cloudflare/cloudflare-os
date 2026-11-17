import { describe, expect, it } from 'vitest'
import { movedKeys } from './movedKeys'

const moved = (before: string, after: string) => [...movedKeys([...before], [...after])].toSorted().join('')

describe('movedKeys', () => {
  it('finds nothing moved when the order is kept, whatever arrived or left', () => {
    expect(moved('abcd', 'abcd')).toBe('')
    expect(moved('abcd', 'xabd')).toBe('')
  })

  it('finds the one taken out of its place and put elsewhere, however far', () => {
    expect(moved('abcde', 'dabce')).toBe('d')
    expect(moved('abcde', 'acdeb')).toBe('b')
  })

  it('takes the fewest to have moved', () => {
    expect(moved('abcdef', 'efabcd')).toBe('ef')
  })
})
