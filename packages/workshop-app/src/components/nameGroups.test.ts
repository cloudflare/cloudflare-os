import { describe, expect, it } from 'vitest'
import { groupByName } from './nameGroups'

const groups = (names: string[], enough?: number) => groupByName(names, (name) => name, enough).map(({ label, entries }) => [label, entries.map(({ value }) => value)])

describe('groupByName', () => {
  it('gives a letter with enough names a group of its own, in order', () => {
    expect(groups(['Beta', 'alpha', 'Bravo', 'Apex'])).toEqual([
      ['A', ['alpha', 'Apex']],
      ['B', ['Beta', 'Bravo']],
    ])
  })

  it('folds a letter with too few into those after it, and leaves the last apart', () => {
    expect(groups(['Zulu', 'Delta', 'Alpha', 'Echo', 'Mike', 'Mango'])).toEqual([
      ['A – D', ['Alpha', 'Delta']],
      ['E – M', ['Echo', 'Mango', 'Mike']],
      ['Z', ['Zulu']],
    ])
  })

  it('folds up to as many as are asked for', () => {
    expect(groups(['Alpha', 'Apex', 'Beta', 'Bravo', 'Echo', 'Zulu'], 4)).toEqual([
      ['A – B', ['Alpha', 'Apex', 'Beta', 'Bravo']],
      ['E – Z', ['Echo', 'Zulu']],
    ])
  })

  it('lists a name under its letter whatever its case or accents, and numbers by their size', () => {
    expect(groups(['Écran', 'eagle', 'Workspace 10', 'Workspace 2'])).toEqual([
      ['E', ['eagle', 'Écran']],
      ['W', ['Workspace 2', 'Workspace 10']],
    ])
  })

  it('puts names that start with no letter first', () => {
    expect(groups(['Alpha', '2026 plan', '', 'Atlas', '🚀 Launch'])).toEqual([
      ['#', ['', '🚀 Launch', '2026 plan']],
      ['A', ['Alpha', 'Atlas']],
    ])
  })
})
