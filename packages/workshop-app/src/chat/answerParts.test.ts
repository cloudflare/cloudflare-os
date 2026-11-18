import { describe, expect, it } from 'vitest'
import { answerParts, answerProse } from './answerParts'

const VIEW = '<title>Plans</title>\n<button>Pick</button>'

describe('answerParts', () => {
  it('leaves prose alone', () => {
    expect(answerParts('Just **words**, and <inline-html> in a line.')).toEqual([{ type: 'text', text: 'Just **words**, and <inline-html> in a line.' }])
  })

  it('takes out each view, in order, by its title', () => {
    const text = `Here are the plans:\n\n<inline-html>\n${VIEW}\n</inline-html>\n\nPick one.`
    expect(answerParts(text)).toEqual([
      { type: 'text', text: 'Here are the plans:\n\n' },
      { type: 'view', html: VIEW, title: 'Plans', error: undefined },
      { type: 'text', text: '\n\nPick one.' },
    ])
  })

  it('leaves out the space between two views', () => {
    const text = '<inline-html>\n<p>one</p>\n</inline-html>\n\n<inline-html>\n<p>two</p>\n</inline-html>'
    expect(answerParts(text).map((part) => part.type)).toEqual(['view', 'view'])
  })

  it('says why a view with nothing in it does not run', () => {
    expect(answerParts('<inline-html>\n<title>Empty</title>\n</inline-html>')).toMatchObject([{ type: 'view', title: 'Empty', error: 'This view has no content.' }])
  })

  it('leaves a tag inside a code block as code', () => {
    const text = '```html\n<inline-html>\n<p>example</p>\n</inline-html>\n```'
    expect(answerParts(text)).toEqual([{ type: 'text', text }])
  })

  it('draws a block still being written as it is drafted', () => {
    expect(answerParts('A chart:\n\n<inline-html>\n<title>Weeks</title>\n<svg>', { streaming: true })).toEqual([
      { type: 'text', text: 'A chart:\n\n' },
      { type: 'view', html: '<title>Weeks</title>\n<svg>', title: 'Weeks', drawing: true },
    ])
  })

  it('does not close a block on a closing tag still arriving', () => {
    expect(answerParts('<inline-html>\n<p>x</p>\n</inline-ht', { streaming: true })).toMatchObject([{ type: 'view', html: '<p>x</p>', drawing: true }])
  })

  it('shows a block the written answer never closed as code, rather than running half of it', () => {
    const [part] = answerParts('<inline-html>\n<p>```</p>')
    expect(part).toEqual({ type: 'text', text: '````html\n<inline-html>\n<p>```</p>\n````' })
  })
})

describe('answerProse', () => {
  it('is the words around the views', () => {
    expect(answerProse(answerParts(`Here:\n\n<inline-html>\n${VIEW}\n</inline-html>\n\nPick one.`))).toBe('Here:\n\nPick one.')
  })

  it('is what the views are called, when there are no words', () => {
    expect(answerProse(answerParts(`<inline-html>\n${VIEW}\n</inline-html>\n<inline-html>\n<p>x</p>\n</inline-html>`))).toBe('Plans Live view')
  })
})
