import { describe, expect, it } from 'vitest'
import type { ComposerCommand } from './ComposerCommandPicker'
import { leadingCommand, matchCommands, slashTokenAt } from './slashCommands'

const command = (name: string, title: string, description = ''): ComposerCommand => ({ key: name, name, title, description, kind: 'skill' })

describe('slashTokenAt', () => {
  it('finds a slash at the start of the draft or of a word, up to the cursor', () => {
    expect(slashTokenAt('/meet', 5)).toEqual({ start: 0, query: 'meet' })
    expect(slashTokenAt('please /we', 10)).toEqual({ start: 7, query: 'we' })
    expect(slashTokenAt('/', 1)).toEqual({ start: 0, query: '' })
  })

  it('leaves alone a slash inside a word, a path, a double slash, and a word the cursor is in the middle of', () => {
    expect(slashTokenAt('and/or', 6)).toBeUndefined()
    expect(slashTokenAt('src/app', 7)).toBeUndefined()
    expect(slashTokenAt('//', 2)).toBeUndefined()
    expect(slashTokenAt('/meeting', 3)).toBeUndefined()
    expect(slashTokenAt('/meet now', 9)).toBeUndefined()
  })
})

describe('matchCommands', () => {
  const COMMANDS = [command('compact', 'Compact', 'Make room'), command('weekly-update', 'Weekly update', 'For a manager'), command('meeting-brief', 'Meeting brief', 'Before a meeting, weekly or not')]

  it('offers everything for a bare slash, as given', () => {
    expect(matchCommands(COMMANDS, '').map(({ name }) => name)).toEqual(['compact', 'weekly-update', 'meeting-brief'])
  })

  it('puts names that start with it first, then a word that does, then what they are for', () => {
    expect(matchCommands(COMMANDS, 'brief').map(({ name }) => name)).toEqual(['meeting-brief'])
    expect(matchCommands(COMMANDS, 'week').map(({ name }) => name)).toEqual(['weekly-update', 'meeting-brief'])
    expect(matchCommands(COMMANDS, 'up').map(({ name }) => name)).toEqual(['weekly-update'])
    expect(matchCommands(COMMANDS, 'zzz')).toEqual([])
  })
})

describe('leadingCommand', () => {
  const COMMANDS = [command('meeting-brief', 'Meeting brief')]

  it('reads a command typed out in full, and the words it is given', () => {
    expect(leadingCommand(COMMANDS, '/meeting-brief for Tuesday')).toEqual({ command: COMMANDS[0], args: 'for Tuesday' })
    expect(leadingCommand(COMMANDS, '/Meeting-brief')).toEqual({ command: COMMANDS[0], args: '' })
  })

  it('leaves a message that only starts with a slash as it is', () => {
    expect(leadingCommand(COMMANDS, '/meeting')).toBeUndefined()
    expect(leadingCommand(COMMANDS, '/meeting-briefs')).toBeUndefined()
    expect(leadingCommand(COMMANDS, 'about /meeting-brief')).toBeUndefined()
  })
})
