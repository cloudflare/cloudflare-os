import { describe, expect, it } from 'vitest'
import type { ComposerCommand } from './composerCommand'
import { composerAddEntries, composerAddGivesWay, composerAddKey, type ComposerAddList, type ComposerAddOffer } from './composerAddEntries'

const command = (name: string, title: string, description: string, kind: ComposerCommand['kind'] = 'skill'): ComposerCommand =>
  ({ key: name, name, title, description, kind })

const COMMANDS = [
  command('meeting-brief', 'Meeting Brief', 'Prepare for a meeting'),
  command('review-writing', 'Review Writing', 'Polish a brief draft'),
  command('invoice-check', 'Invoice Check', 'Read an invoice through'),
  command('compact', 'Compact', 'Sum up the chat so far', 'builtin'),
]

const offer = (group: ComposerAddOffer['group'], key: string, title: string, more: Partial<ComposerAddOffer> = {}): ComposerAddOffer =>
  ({ key: `${group}:${key}`, group, title, icon: null, onChoose: () => {}, ...more })

const OFFERS = [
  offer('format', 'slides', 'Slides', { suggested: true, detail: 'Make slides' }),
  offer('format', 'board', 'Board'),
  offer('setup', 'automation', 'Automation', { suggested: true, keywords: ['scheduled'] }),
  offer('connection', 'google', 'Google', { suggested: true, keywords: ['Drive', 'Calendar'] }),
  offer('connection', 'github', 'GitHub', { suggested: true, detail: 'Repository' }),
  offer('connection', 'slack', 'Slack', { detail: 'Sign in to connect' }),
  offer('template', 'tips', 'Tip Jar', { detail: 'Template' }),
  offer('template', 'brief', 'Brief Builder', { detail: 'Template · Ada' }),
]

const listed = (query: string, list?: ComposerAddList, commands = COMMANDS, offers = OFFERS) =>
  composerAddEntries({ commands, offers, upload: true }, query, list).map(({ key }) => key)

describe('composerAddEntries', () => {
  it('opens with uploading, what is offered first, then the ways on to all the skills and connections', () => {
    expect(listed('')).toEqual(['upload', 'format:slides', 'setup:automation', 'connection:google', 'connection:github', 'all:skill', 'all:connection'])
    expect(composerAddEntries({ commands: COMMANDS, offers: OFFERS, upload: true }, '').slice(-2)).toEqual([
      { key: 'all:skill', kind: 'all', list: 'skill', title: 'See all skills…' },
      { key: 'all:connection', kind: 'all', list: 'connection', title: 'See all connections…' },
    ])
  })

  it('has a way on only to what there is, and to the skills while they are still being read', () => {
    expect(listed('', undefined, [], [])).toEqual(['upload'])
    expect(composerAddEntries({ commands: [], upload: true, loading: true }, '').at(-1)).toMatchObject({ key: 'all:skill' })
  })

  it('says uploading is unavailable where it is, rather than leaving it out', () => {
    expect(composerAddEntries({ commands: [], upload: false }, '')).toEqual([expect.objectContaining({ key: 'upload', kind: 'upload', disabled: true })])
  })

  it('lists all of a kind once gone on to it: the skills, then the app’s commands; or every service', () => {
    expect(listed('', 'skill')).toEqual(['command:meeting-brief', 'command:review-writing', 'command:invoice-check', 'command:compact'])
    expect(listed('', 'connection')).toEqual(['connection:google', 'connection:github', 'connection:slack'])
  })

  it('narrows a kind gone on to by what is typed, and finds nothing of another kind there', () => {
    expect(listed('sla', 'connection')).toEqual(['connection:slack'])
    expect(listed('slides', 'connection')).toEqual([])
    expect(listed('brief', 'skill')).toEqual(['command:meeting-brief', 'command:review-writing'])
  })

  it('finds what fits what is typed across every kind, best first, templates and what is not offered first included', () => {
    // A title that starts with it, then one with a word that does, then what it is known by besides.
    expect(listed('brief')).toEqual(['template:brief', 'command:meeting-brief', 'command:review-writing'])
    expect(listed('board')).toEqual(['format:board'])
    expect(listed('zzz')).toEqual([])
  })

  it('finds a service by its kinds, a skill by what it is for, and uploading by what it takes', () => {
    expect(listed('calendar')).toEqual(['connection:google'])
    expect(listed('invoice')).toEqual(['command:invoice-check'])
    expect(listed('photo')).toEqual(['upload'])
    expect(listed('scheduled')).toEqual(['setup:automation'])
  })

  it('takes nothing but spaces as nothing typed', () => {
    expect(listed('   ')).toEqual(listed(''))
  })
})

describe('composerAddKey', () => {
  const [upload, slides] = composerAddEntries({ commands: COMMANDS, offers: OFFERS, upload: false }, '')

  it('chooses the highlighted row on Tab, unless it cannot be chosen or there is none', () => {
    expect(composerAddKey('Tab', { highlighted: slides })).toBe('choose')
    expect(composerAddKey('Tab', { highlighted: upload })).toBe('close')
    expect(composerAddKey('Tab', { highlighted: undefined })).toBe('close')
  })

  it('leaves Escape to the menu, and keeps letters and arrows from it', () => {
    expect(composerAddKey('Escape', { highlighted: slides })).toBe('close')
    for (const key of ['a', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Backspace']) expect(composerAddKey(key, { highlighted: slides })).toBe('keep')
  })

  it('goes back from a kind gone on to by Escape, and by Backspace once nothing is typed', () => {
    expect(composerAddKey('Escape', { highlighted: slides, onList: true, typed: true })).toBe('back')
    expect(composerAddKey('Backspace', { highlighted: slides, onList: true })).toBe('back')
    expect(composerAddKey('Backspace', { highlighted: slides, onList: true, typed: true })).toBe('keep')
  })

  it('opened by what was typed in the draft, gives way to keys that are the draft’s until something is typed in it', () => {
    const typedOpen = { highlighted: slides, tentative: true }
    expect(composerAddKey('Backspace', typedOpen)).toBe('undo')
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete']) expect(composerAddKey(key, typedOpen)).toBe('leave')
    // What looks for something, moves through what is listed or chooses from it is the menu's.
    for (const key of ['a', ' ', 'ArrowDown', 'ArrowUp', 'Enter']) expect(composerAddKey(key, typedOpen)).toBe('keep')
    expect(composerAddKey('Tab', typedOpen)).toBe('choose')
    expect(composerAddKey('Escape', typedOpen)).toBe('close')
    // Once something is typed in it, they are its field's.
    for (const key of ['Backspace', 'ArrowLeft', 'Home']) expect(composerAddKey(key, { ...typedOpen, typed: true })).toBe('keep')
    // Gone on to a kind, it is being looked through.
    expect(composerAddKey('Backspace', { ...typedOpen, onList: true })).toBe('back')
    expect(composerAddKey('ArrowLeft', { ...typedOpen, onList: true })).toBe('keep')
  })
})

describe('composerAddGivesWay', () => {
  const source = { commands: COMMANDS, offers: OFFERS, upload: true }

  it('gives way to a space typed straight away, and to words that find nothing', () => {
    expect(composerAddGivesWay(source, ' ')).toBe(true)
    expect(composerAddGivesWay(source, ' meeting')).toBe(true)
    expect(composerAddGivesWay(source, 'usr')).toBe(true)
  })

  it('stays for what finds something, a space in it included, and with nothing typed', () => {
    expect(composerAddGivesWay(source, '')).toBe(false)
    expect(composerAddGivesWay(source, 'meet')).toBe(false)
    expect(composerAddGivesWay(source, 'meeting b')).toBe(false)
    expect(composerAddGivesWay(source, 'slides ')).toBe(false)
  })

  it('stays while the skills are still being read, when it cannot tell', () => {
    expect(composerAddGivesWay({ ...source, commands: [], loading: true }, 'usr')).toBe(false)
  })
})
