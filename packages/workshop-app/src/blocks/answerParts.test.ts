import { describe, expect, it } from 'vitest'
import { answerParts, proseOf, viewBeingDrawn } from './answerParts'

const ANSWER = `Signups rose every week.

<inline-html>
<title>Weekly signups</title>
<div id="chart"></div>
</inline-html>

Want them by country?`

describe('answerParts', () => {
  it('is the whole answer as prose when it draws no view', () => {
    expect(answerParts('Just words.')).toEqual([{ kind: 'prose', text: 'Just words.' }])
  })

  it('splits an answer into its words and the views between them', () => {
    expect(answerParts(ANSWER)).toEqual([
      { kind: 'prose', text: 'Signups rose every week.' },
      { kind: 'view', html: '<title>Weekly signups</title>\n<div id="chart"></div>', title: 'Weekly signups' },
      { kind: 'prose', text: 'Want them by country?' },
    ])
  })

  it('leaves out the space between two views', () => {
    const parts = answerParts('<inline-html>\n<p>One</p>\n</inline-html>\n\n<inline-html>\n<p>Two</p>\n</inline-html>')
    expect(parts.map(({ kind }) => kind)).toEqual(['view', 'view'])
  })

  it('says why a view with nothing but its title will not run', () => {
    expect(answerParts('<inline-html>\n<title>Empty</title>\n</inline-html>')).toEqual([
      { kind: 'view', html: '<title>Empty</title>', title: 'Empty', error: 'This view has no content.' },
    ])
  })

  it('shows what a view never closed has, once the answer is finished', () => {
    expect(answerParts('Here.\n\n<inline-html>\n<p>Half</p>')).toEqual([
      { kind: 'prose', text: 'Here.' },
      { kind: 'view', html: '<p>Half</p>' },
    ])
  })

  it('keeps a tag in a code example as words', () => {
    const example = 'Write:\n\n```\n<inline-html>\n<p>Hi</p>\n</inline-html>\n```'
    expect(answerParts(example)).toEqual([{ kind: 'prose', text: example }])
  })
})

describe('proseOf', () => {
  it('is what the answer says, without its views', () => {
    expect(proseOf(ANSWER)).toBe('Signups rose every week.\n\nWant them by country?')
  })
})

describe('viewBeingDrawn', () => {
  it('names the view an answer is drawing, once its title has arrived', () => {
    expect(viewBeingDrawn('Here.\n\n<inline-html>\n<title>Weekly signups</title>\n<div>')).toEqual({ title: 'Weekly signups' })
    expect(viewBeingDrawn('Here.\n\n<inline-html>\n<sty')).toEqual({ title: undefined })
  })

  it('is nothing while it writes words, or once the view is closed', () => {
    expect(viewBeingDrawn('Signups rose')).toBeUndefined()
    expect(viewBeingDrawn(`${ANSWER.split('\n\nWant')[0]}\n\nWant`)).toBeUndefined()
  })
})
