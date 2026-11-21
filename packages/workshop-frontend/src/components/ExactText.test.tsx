// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ExactText } from './ExactText'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let host: HTMLDivElement | undefined
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

const render = async (text: string, singleLine = false) => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(<ExactText text={text} singleLine={singleLine} />))
  return host.firstElementChild as HTMLElement
}

/** The code-point tokens, in order. */
const tokens = (element: HTMLElement) =>
  [...element.querySelectorAll('span[title]')]
    .filter(span => span.getAttribute('title') !== 'U+0020')
    .map(span => span.textContent)

/** The marked spaces. */
const spaceMarks = (element: HTMLElement) => [...element.querySelectorAll('span[title="U+0020"]')]

describe('ExactText', () => {
  it.each([
    ['a bidi override', '\u202E', 'U+202E'],
    ['a zero-width space', '\u200B', 'U+200B'],
    ['a NUL', '\u0000', 'U+0000'],
    ['a C1 control', '\u0085', 'U+0085'],
    ['a tab', '\t', 'U+0009'],
    ['a no-break space', '\u00A0', 'U+00A0'],
    ['a line separator', '\u2028', 'U+2028'],
    ['an ideographic space', '\u3000', 'U+3000'],
    ['a blank braille pattern', '\u2800', 'U+2800'],
    ['an astral tag character', '\u{E0041}', 'U+E0041'],
  ])('draws %s as a token naming its code point', async (_name, character, label) => {
    const element = await render(`in${character}voice`)
    expect(tokens(element)).toEqual([label])
    expect(element.querySelector(`span[title="${label}"]`)).not.toBeNull()
    // The character itself is gone: only the token stands for it.
    expect(element.textContent).toBe(`in${label}voice`)
  })

  it('breaks the line at a line break, and draws it as a token in a single line', async () => {
    const broken = await render('one\ntwo')
    expect(tokens(broken)).toEqual([])
    expect(broken.textContent).toBe('one\ntwo')

    const single = await render('one\ntwo', true)
    expect(tokens(single)).toEqual(['U+000A'])
    expect(single.textContent).toBe('oneU+000Atwo')
  })

  it('leaves ordinary text as it is, spaces between words and indentation included', async () => {
    const text = '  indented line\n    deeper, with two  spaces'
    const element = await render(text)
    expect(element.querySelectorAll('span')).toHaveLength(0)
    expect(element.textContent).toBe(text)
  })

  it('marks each space that ends a line, and none with text after it', async () => {
    const element = await render('fix  \nbody')
    expect(spaceMarks(element)).toHaveLength(2)
    // One character per space, so the text keeps its length.
    expect(element.textContent).toHaveLength('fix  \nbody'.length)
    expect(element.textContent!.split('\n')[1]).toBe('body')
  })

  it('marks every space of a line that is spaces only', async () => {
    const element = await render('a\n   \nb')
    expect(spaceMarks(element)).toHaveLength(3)
    expect(element.textContent).toHaveLength(7)
  })

  it('marks every space of a text that is spaces only', async () => {
    const element = await render('   ')
    expect(spaceMarks(element)).toHaveLength(3)
    expect(element.textContent).toHaveLength(3)
  })

  it('marks the spaces that end a single line, and not those before a line break in it', async () => {
    expect(spaceMarks(await render('name ', true))).toHaveLength(1)
    const element = await render('a  \nb', true)
    expect(spaceMarks(element)).toHaveLength(0)
    expect(tokens(element)).toEqual(['U+000A'])
  })

  it('marks no space between words', async () => {
    expect(spaceMarks(await render('a b'))).toHaveLength(0)
  })
})
