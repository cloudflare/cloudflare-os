import { describe, expect, it } from 'vitest'
import type { ComposerCommand } from './ComposerCommandPicker'
import { composerAddEntries, composerAddKey } from './composerAddEntries'

const command = (name: string, title: string, description: string, kind: ComposerCommand['kind'] = 'skill'): ComposerCommand =>
  ({ key: name, name, title, description, kind })

const COMMANDS = [
  command('compact', 'Compact', 'Sum up the chat so far', 'builtin'),
  command('meeting-brief', 'Meeting Brief', 'Prepare for a meeting'),
  command('review-writing', 'Review Writing', 'Polish a brief draft'),
]
const BOTH = { upload: true, connection: true }
const keys = (query: string, can = BOTH) => composerAddEntries(COMMANDS, query, can).map(({ key }) => key)

describe('composerAddEntries', () => {
  it('starts with uploading and a connection, then the skills in their order, then the app’s commands', () => {
    expect(keys('')).toEqual(['upload', 'connection', 'command:meeting-brief', 'command:review-writing', 'command:compact'])
  })

  it('marks what cannot be done as disabled, rather than leaving it out', () => {
    expect(composerAddEntries([], '', { upload: true, connection: false })).toEqual([
      { key: 'upload', kind: 'action', disabled: false },
      { key: 'connection', kind: 'action', disabled: true },
    ])
  })

  it('narrows to the skills and commands that fit what is typed, as a slash does', () => {
    expect(keys('Meet')).toEqual(['command:meeting-brief'])
    // A word of the title first, then what it is for.
    expect(keys('brief')).toEqual(['command:meeting-brief', 'command:review-writing'])
    expect(keys('zzz')).toEqual([])
  })

  it('takes nothing but spaces as nothing typed', () => {
    expect(keys('   ')).toEqual(keys(''))
  })
})

describe('composerAddKey', () => {
  const [upload, connection, skill] = composerAddEntries(COMMANDS, '', { upload: true, connection: false })

  it('chooses the highlighted row on Tab, unless it cannot be chosen or there is none', () => {
    expect(composerAddKey('Tab', skill)).toBe('choose')
    expect(composerAddKey('Tab', upload)).toBe('choose')
    expect(composerAddKey('Tab', connection)).toBe('close')
    expect(composerAddKey('Tab', undefined)).toBe('close')
  })

  it('leaves Escape to the menu, and keeps letters and arrows from it', () => {
    expect(composerAddKey('Escape', skill)).toBe('close')
    for (const key of ['a', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) expect(composerAddKey(key, skill)).toBe('keep')
  })
})
