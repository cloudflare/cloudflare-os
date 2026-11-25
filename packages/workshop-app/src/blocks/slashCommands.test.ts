import { describe, expect, it } from 'vitest'
import type { ComposerCommand } from './composerCommand'
import { leadingCommand } from './slashCommands'

const command = (name: string, title: string, description = ''): ComposerCommand => ({ key: name, name, title, description, kind: 'skill' })

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
