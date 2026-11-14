import { describe, expect, it } from 'vitest'
import type { SlashCommandChoice } from '@gadgets/workshop-shared/api'
import { composerCommandOf, missingCommand, orderCommands, skillCommandOf, slashRequestFor } from './slashCommands'

const SKILL: SlashCommandChoice = {
  selection: { gatekeeperId: 7, commandId: 'c1/meeting-brief/SKILL.md' },
  name: 'meeting-brief',
  description: 'Before a meeting',
  providerLabel: 'Context Library',
}
const COMPACT: SlashCommandChoice = { selection: { builtin: true, commandId: 'compact' }, name: 'compact', description: 'Compact context', providerLabel: 'Workshop' }

describe('composer commands', () => {
  it('names a skill in plain words, and a built-in in the app’s own', () => {
    expect(composerCommandOf(SKILL)).toMatchObject({ name: 'meeting-brief', title: 'Meeting brief', kind: 'skill', source: 'Context Library' })
    expect(composerCommandOf(COMPACT)).toMatchObject({ name: 'compact', title: 'Compact', kind: 'builtin' })
  })

  it('knows a Library skill as the workspace that offers it does, whichever gatekeeper offers it there', () => {
    const fromLibrary = skillCommandOf({ id: 'c1/meeting-brief/SKILL.md', name: 'meeting-brief', description: 'Before a meeting' })
    expect(fromLibrary.key).toBe(composerCommandOf(SKILL).key)
    expect(slashRequestFor([COMPACT, SKILL], fromLibrary, 'for Tuesday')).toEqual({ id: SKILL.selection, args: 'for Tuesday', commandPosition: 0 })
  })

  it('offers skills first, by name, then the app’s own commands', () => {
    const weekly = { ...SKILL, name: 'weekly-update', selection: { gatekeeperId: 7, commandId: 'c1/weekly-update/SKILL.md' } }
    expect(orderCommands([COMPACT, weekly, SKILL].map(composerCommandOf)).map(({ name }) => name)).toEqual(['meeting-brief', 'weekly-update', 'compact'])
  })

  it('finds nothing to send for a skill the workspace no longer offers, and says why', () => {
    const gone = skillCommandOf({ id: 'c1/old/SKILL.md', name: 'old', description: '' })
    expect(slashRequestFor([SKILL], gone, '')).toBeUndefined()
    expect(missingCommand(gone)).toMatch(/Old isn’t available here/)
  })
})
