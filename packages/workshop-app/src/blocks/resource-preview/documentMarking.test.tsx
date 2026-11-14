// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { DocumentEdit, ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { placeEdits, plainText } from './documentMarking'
import { changeElements, previewTestRoot, renderPreview } from './previewTestRoot'

const testRoot = previewTestRoot()
afterEach(() => testRoot.cleanup())

const ACTIONS = [11, 12, 13, 14]

const doc = (markdown: string, edits: DocumentEdit[], actions = ACTIONS): ResourcePreview => ({
  title: 'Plan',
  actions,
  content: { type: 'document', tabs: [{ id: 't', title: 'Plan', markdown, edits }] },
})

const render = (markdown: string, edits: DocumentEdit[], actions = ACTIONS) =>
  testRoot.render(renderPreview(doc(markdown, edits, actions)))

const inserted = (container: Element, changeId: number) =>
  changeElements(container, changeId).filter(e => e.tagName === 'INS').map(e => e.textContent).join('|')
const removed = (container: Element, changeId: number) =>
  changeElements(container, changeId).filter(e => e.tagName === 'DEL').map(e => e.textContent).join('|')

describe('placing document edits', () => {
  it('marks only the words that differ, inside a list item', async () => {
    const page = await render('- Launch on **May 3**\n- Retro after\n', [
      { change: 0, before: '- Launch on **April 28**', after: '- Launch on **May 3**' },
    ])
    expect(inserted(page, 11)).toBe('May 3')
    expect(removed(page, 11)).toBe('April 28')
    const mark = changeElements(page, 11).find(e => e.tagName === 'INS')!
    expect(mark.closest('li')?.textContent).toContain('Launch on')
    expect(mark.closest('strong')).not.toBeNull()
    expect(page.querySelectorAll('li')).toHaveLength(2)
  })

  it('marks a heading edit within the heading, leaving its syntax alone', async () => {
    const page = await render('# Plan\n\n## Phased rollout\n\nText.\n', [
      { change: 0, before: '## Launch rollout', after: '## Phased rollout' },
    ])
    const heading = page.querySelector('h2')!
    expect(changeElements(page, 11).every(mark => heading.contains(mark))).toBe(true)
    expect(inserted(page, 11)).toBe('Phased')
    expect(removed(page, 11)).toBe('Launch')
    expect(page.textContent).not.toContain('##')
  })

  it('marks a table cell edit inside its cell', async () => {
    const page = await render('| Area | Status |\n| --- | --- |\n| Ads | Approved |\n| Web | Draft |\n', [
      { change: 0, before: '| Ads | In review |', after: '| Ads | Approved |' },
    ])
    const ins = changeElements(page, 11).find(e => e.tagName === 'INS')!
    expect(ins.closest('td')?.textContent).toContain('Approved')
    expect(removed(page, 11)).toBe('In review')
    expect(page.querySelectorAll('tr')).toHaveLength(3)
  })

  it('marks adjacent edits separately', async () => {
    const page = await render('Ship alpha beta today.\n', [
      { change: 0, before: 'one', after: 'alpha' },
      { change: 1, before: 'two', after: ' beta' },
    ])
    expect(inserted(page, 11)).toBe('alpha')
    expect(inserted(page, 12)).toBe('beta')
    expect(page.querySelector('p')?.textContent).toBe('Ship onealpha twobeta today.')
  })

  it('shows a deletion, which has nothing in the text to find, as a note', async () => {
    const page = await render('Kept.\n', [{ change: 0, before: 'Draft only.', after: '' }])
    const [note] = changeElements(page, 11)
    expect(note.tagName).toBe('BUTTON')
    expect(note.textContent).toContain('Draft only.')
    expect(note.getAttribute('aria-label')).toBe('Change: remove Draft only.')
  })

  it('marks an append at the end', async () => {
    const markdown = 'First.\n\nClosing note.\n'
    const page = await render(markdown, [{ change: 0, before: '', after: '\n\nClosing note.\n' }])
    expect(inserted(page, 11)).toBe('Closing note.')
    expect(changeElements(page, 11)[0].closest('p')).toBe(page.querySelectorAll('p')[1])
  })

  it('marks text spanning several blocks in each, with one button for the change', async () => {
    const page = await render('Intro.\n\nOne.\n\nTwo.\n', [{ change: 0, before: '', after: 'One.\n\nTwo.' }])
    expect(inserted(page, 11)).toBe('One.|Two.')
    expect(changeElements(page, 11).filter(e => e.getAttribute('role') === 'button')).toHaveLength(1)
  })

  it('keeps emphasis that starts right where an edit does', async () => {
    const page = await render('Say _quietly_ now.\n', [{ change: 0, before: '', after: '_quietly_ now' }])
    expect(page.querySelector('em')?.textContent).toBe('quietly')
    expect(inserted(page, 11)).toBe('quietly| now')
  })

  it('does not guess: missing, repeated and overlapped edits become notes', () => {
    const markdown = 'Owner: Maya. Reviewer: Maya.\n\nThe final text.\n'
    const { placed, unplaced } = placeEdits(markdown, [
      { change: 0, before: 'x', after: 'Not there' },
      { change: 1, before: 'Sam', after: 'Maya' },
      { change: 2, before: '', after: 'The final' },
      { change: 3, before: 'draft', after: 'final text' },
    ], ACTIONS)
    expect(unplaced.map(u => [u.changeId, u.reason])).toEqual([[11, 'not-found'], [12, 'ambiguous'], [13, 'overlap']])
    expect(placed.map(p => p.changeId)).toEqual([14])
  })

  it('leaves an edit with no text to mark as a note', () => {
    expect(placeEdits('A\n\n---\n\nB\n', [{ change: 0, before: '', after: '---' }], ACTIONS).unplaced[0].reason).toBe('no-text')
  })

  it('shows notes for unplaced edits at the top of the page', async () => {
    const page = await render('Maya and Maya.\n', [{ change: 0, before: 'Sam', after: 'Maya' }])
    const [note] = changeElements(page, 11)
    expect(note.textContent).toContain('appears more than once')
    expect(page.querySelector('article')?.firstElementChild?.contains(note)).toBe(true)
  })

  it('draws an unattributed edit as a change without making it a target', async () => {
    const page = await render('Ship it now.\n', [{ change: 0, before: 'later', after: 'now' }], [-1])
    const ins = page.querySelector('ins')!
    expect(ins.textContent).toBe('now')
    expect(ins.hasAttribute('data-change-id')).toBe(false)
    expect(ins.getAttribute('role')).toBeNull()
  })

  it('maps through escapes and inline code', async () => {
    const page = await render('Use `npm ci` or 5 \\* 3.\n', [{ change: 0, before: 'x', after: '5 \\* 3' }])
    expect(inserted(page, 11)).toBe('5 * 3')
  })
})

describe('plainText', () => {
  it('drops Markdown syntax from removed text', () => {
    expect(plainText('## **Bold** [link](https://x.test) `code`')).toBe('Bold link code')
    expect(plainText('| A | B |')).toBe('A B')
  })
})

describe('placeEdits by context', () => {
  it('places a deletion where its context says it stood', () => {
    const markdown = 'Intro paragraph.\n\nClosing words.'
    const { placed, unplaced } = placeEdits(markdown, [{
      change: 0, before: 'Removed sentence.\n\n', after: '',
      context: { before: 'Intro paragraph.\n\n', after: 'Closing words.' },
    }], [7])
    expect(unplaced).toEqual([])
    expect(placed).toEqual([expect.objectContaining({
      changeId: 7, start: 18, end: 18, inserted: [], removed: [{ at: 18, text: 'Removed sentence.' }],
    })])
  })

  it('places text that occurs twice by the context around the one it is', () => {
    const markdown = 'Total: 12\n\nTotal: 12 again'
    const { placed } = placeEdits(markdown, [{
      change: 0, before: '10', after: '12', context: { before: 'Total: ', after: ' again' },
    }], [3])
    expect(placed[0]).toMatchObject({ start: 18, end: 20 })
  })

  it('leaves a deletion unplaced when its context is gone', () => {
    const { unplaced } = placeEdits('Rewritten.', [{
      change: 0, before: 'Gone.', after: '', context: { before: 'Old ', after: ' text' },
    }], [1])
    expect(unplaced).toEqual([expect.objectContaining({ reason: 'deletion' })])
  })
})
