import { describe, expect, it } from 'vitest'
import type { ComposerCommand } from './composerCommand'
import type { ComposerConnection } from './ComposerConnectionLines'
import {
  appendedText, draftAfterSent, draftAllowed, draftCommand, draftConnections, draftFormat, draftOf, draftPills, draftWords, menuOpenerAt, withoutPill,
  withoutWordsAt, withPill, withPillForWords, wordsAround, type DraftDocument, type DraftFormat, type DraftPill,
} from './composerDraft'

const brief: ComposerCommand = { key: 'brief', name: 'meeting-brief', title: 'Meeting Brief', description: 'Before a meeting.', kind: 'skill' }
const plan: ComposerConnection = { key: 'plan', title: 'Q3 plan', kind: 'Google Doc', service: { name: 'Google' } }
const repo: ComposerConnection = { key: 'repo', title: 'cloudflare/gadgets', kind: 'Repository', service: { name: 'GitHub' } }
const document: DraftFormat = { noun: 'Document', icon: 'fileText' }

const command = (data: ComposerCommand, id = `command-${data.key}`): DraftPill => ({ type: 'item', id, itemType: 'command', data })
const connection = (data: ComposerConnection, id = `connection-${data.key}`): DraftPill => ({ type: 'item', id, itemType: 'connection', data })
const format = (data: DraftFormat, id = 'format'): DraftPill => ({ type: 'item', id, itemType: 'format', data })
const at = (position: number) => ({ anchor: position, focus: position })

describe('what a draft holds', () => {
  const draft: DraftDocument = [format(document), command(brief), connection(plan), connection(repo), 'compare them']

  it('is its skill, its format and its connections, in the order they were added', () => {
    expect(draftPills(draft)).toHaveLength(4)
    expect(draftCommand(draft)?.data).toBe(brief)
    expect(draftFormat(draft)?.data).toBe(document)
    expect(draftConnections(draft)).toEqual([plan, repo])
    expect(draftCommand(['only words'])).toBeUndefined()
  })

  it('is said apart from its words, which are what is written after it', () => {
    expect(draftWords(draft)).toBe('compare them')
    expect(draftWords([command(brief), '  for Tuesday  '])).toBe('for Tuesday')
    expect(draftWords([connection(plan)])).toBe('')
  })
})

describe('draftAllowed', () => {
  it('has the pills at the start, ahead of the words', () => {
    expect(draftAllowed([command(brief), connection(plan), 'words'])).toBe(true)
    expect(draftAllowed(['only words'])).toBe(true)
    expect(draftAllowed([])).toBe(true)
    // Nothing is written ahead of a pill, or between two.
    expect(draftAllowed(['words ', connection(plan)])).toBe(false)
    expect(draftAllowed([command(brief), ' ', connection(plan), 'words'])).toBe(false)
    expect(draftAllowed([command(brief), 'see ', connection(plan), ' now'])).toBe(false)
  })

  it('has one skill, one format, and each connection once', () => {
    expect(draftAllowed([command(brief, 'a'), command(brief, 'b')])).toBe(false)
    expect(draftAllowed([format(document, 'a'), format(document, 'b')])).toBe(false)
    expect(draftAllowed([connection(plan, 'a'), connection(plan, 'b')])).toBe(false)
    expect(draftAllowed([connection(plan), connection(repo)])).toBe(true)
  })
})

describe('withPill', () => {
  it('adds the pill after those the draft has, ahead of its words', () => {
    expect(withPill(['one two'], command(brief)).draft).toEqual([command(brief), 'one two'])
    expect(withPill([command(brief), 'one two'], connection(plan)).draft).toEqual([command(brief), connection(plan), 'one two'])
    expect(withPill([], connection(plan)).draft).toEqual([connection(plan)])
  })

  it('keeps the cursor in the words where it was', () => {
    const { move } = withPill([command(brief), 'one two'], connection(plan))
    expect(move(4)).toBe(5)
    expect(move(8)).toBe(9)
    // A place among the pills, where the cursor cannot be, is the start of the words.
    expect(move(0)).toBe(2)
  })

  it('takes the place of the pill it stands in for, where that one was', () => {
    const sheet = format({ noun: 'Spreadsheet', icon: 'table' }, 'sheet')
    const { draft, move } = withPill([format(document), connection(plan), 'make it short'], sheet, 'format')
    expect(draft).toEqual([sheet, connection(plan), 'make it short'])
    expect(move(6)).toBe(6)
    // One the draft does not have is only added.
    expect(withPill([connection(plan)], sheet, 'gone').draft).toEqual([connection(plan), sheet])
  })
})

describe('withoutPill', () => {
  it('takes the pill off, and says where the cursor then is', () => {
    const { draft, move } = withoutPill([format(document), connection(plan), 'make it short'], 'format')
    expect(draft).toEqual([connection(plan), 'make it short'])
    expect(move(6)).toBe(5)
    expect(move(1)).toBe(1)
  })

  it('leaves a draft that does not have it as it was', () => {
    const { draft, move } = withoutPill(['as it was'], 'format')
    expect(draft).toEqual(['as it was'])
    expect(move(5)).toBe(5)
  })
})

describe('withPillForWords', () => {
  const link = 'https://a.example/x'

  it('takes the words out, with one of the spaces they were between, and adds the pill at the start', () => {
    expect(withPillForWords([command(brief), `see ${link} now`], connection(plan), link)?.draft).toEqual([command(brief), connection(plan), 'see now'])
    expect(withPillForWords([`${link} now`], connection(plan), link)?.draft).toEqual([connection(plan), 'now'])
    expect(withPillForWords([`see ${link}`], connection(plan), link)?.draft).toEqual([connection(plan), 'see '])
    expect(withPillForWords([`see\n${link}\nnow`], connection(plan), link)?.draft).toEqual([connection(plan), 'see\n\nnow'])
  })

  it('keeps the cursor with the words it was in', () => {
    // "see " is 4 long after one pill: the link is from 5 to 24, and the space after it goes too.
    const { move } = withPillForWords([command(brief), `see ${link} now`], connection(plan), link)!
    expect(move(3)).toBe(4)
    expect(move(28)).toBe(9)
    expect(move(25)).toBe(6)
    // In the words that went, it is where they were.
    expect(move(12)).toBe(6)
  })

  it('is nothing where the words are not there', () => {
    expect(withPillForWords(['see it now'], connection(plan), link)).toBeUndefined()
  })

  it('takes them where they are by themselves, not where they start longer ones', () => {
    expect(withPillForWords([`${link}2 and ${link}`], connection(plan), link)?.draft).toEqual([connection(plan), `${link}2 and `])
    expect(withPillForWords([`${link}2`], connection(plan), link)).toBeUndefined()
  })
})

describe('draftAfterSent', () => {
  const sent: DraftDocument = [format(document), command(brief), connection(plan), 'compare them']

  it('keeps the format the draft starts with, and nothing else that went', () => {
    expect(draftAfterSent(sent, sent)).toEqual([format(document)])
    expect(draftAfterSent(['hello'], ['hello'])).toEqual([])
    // As its editor has it, which is never the very draft that was sent.
    expect(draftAfterSent([...sent], sent)).toEqual([format(document)])
  })

  it('keeps what the draft was given while the message was on its way', () => {
    expect(draftAfterSent([format(document), command(brief), connection(plan), connection(repo), 'compare them'], sent)).toEqual([format(document), connection(repo)])
    expect(draftAfterSent([format({ noun: 'Report', icon: 'fileText' }, 'other'), 'hello'], ['hello'])).toEqual([format({ noun: 'Report', icon: 'fileText' }, 'other')])
  })

  it('leaves a draft whose words are no longer the ones that went', () => {
    expect(draftAfterSent([format(document), 'compare them\n\nand the one that waited'], sent)).toBeUndefined()
  })
})

const typed = (text: string) => menuOpenerAt(text, text.length)

describe('menuOpenerAt', () => {
  it('is a slash or an at sign that starts a word', () => {
    expect(typed('/')).toBe('/')
    expect(typed('@')).toBe('@')
    expect(typed('use /')).toBe('/')
    expect(typed('ask\n@')).toBe('@')
    // With words after it, as long as it is not up against them.
    expect(menuOpenerAt('use / for it', 5)).toBe('/')
  })

  it('is not one in the middle of a word, nor one with a word up against it', () => {
    expect(typed('and/')).toBeUndefined()
    expect(typed('ada@')).toBeUndefined()
    expect(typed('https://')).toBeUndefined()
    expect(menuOpenerAt('use /path', 5)).toBeUndefined()
    expect(typed('use #')).toBeUndefined()
    expect(menuOpenerAt('', 0)).toBeUndefined()
  })
})

describe('withoutWordsAt', () => {
  it('takes out what was written there, closing up the space it leaves', () => {
    expect(withoutWordsAt([command(brief), 'use / for it'], 5, '/')?.draft).toEqual([command(brief), 'use for it'])
    expect(withoutWordsAt(['/'], 0, '/')?.draft).toEqual([])
    expect(withoutWordsAt(['ask @'], 4, '@')?.draft).toEqual(['ask '])
    expect(withoutWordsAt(['use / for it'], 4, '/')?.move(12)).toBe(10)
  })

  it('is nothing where that is not what is there any more', () => {
    expect(withoutWordsAt(['use it'], 4, '/')).toBeUndefined()
    expect(withoutWordsAt([command(brief), '/'], 0, '/')).toBeUndefined()
  })
})

describe('draftOf', () => {
  it('opens with the format, then the skill, then the words', () => {
    let made = 0
    const draft = draftOf({ text: 'for Tuesday', command: brief, format: document }, () => `pill-${(made += 1)}`)
    expect(draft).toEqual([format(document, 'pill-1'), command(brief, 'pill-2'), 'for Tuesday'])
    expect(draftOf({}, () => 'unused')).toEqual([])
  })
})

describe('wordsAround', () => {
  it('reads the words and how far into them the cursor is, past the pills', () => {
    expect(wordsAround([command(brief), connection(plan), 'see it now'], 6)).toEqual({ text: 'see it now', offset: 4 })
    expect(wordsAround(['see it now'], 3)).toEqual({ text: 'see it now', offset: 3 })
    expect(wordsAround([connection(plan)], 1)).toEqual({ text: '', offset: 0 })
  })
})

describe('appendedText', () => {
  it('adds a paragraph after what is there, in place of the space it ended with', () => {
    expect(appendedText(['so far  '], 'the logs')).toEqual({ range: { anchor: 6, focus: 8 }, replacement: ['\n\nthe logs'] })
    expect(appendedText([connection(plan), 'so far'], 'the logs')).toEqual({ range: at(7), replacement: ['\n\nthe logs'] })
  })

  it('is all the words of a draft that had none, after its pills', () => {
    expect(appendedText([], 'the logs')).toEqual({ range: at(0), replacement: ['the logs'] })
    expect(appendedText(['  '], 'the logs')).toEqual({ range: { anchor: 0, focus: 2 }, replacement: ['the logs'] })
    expect(appendedText([connection(plan)], 'the logs')).toEqual({ range: at(1), replacement: ['the logs'] })
  })
})
