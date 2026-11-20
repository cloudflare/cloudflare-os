/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import CodeDiffEditor from './CodeDiffEditor'
import { ThemeProvider } from '../../ThemeContext'
import '../../styles.css'

// The overview strip needs real layout: its marks are placed from CodeMirror's height map,
// so these tests check that pressing each mark scrolls its change into view, with deletion
// zones (stacked) and blank zones (split) taking their on-screen space.

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = undefined
  window.localStorage.removeItem('gadgets:workshop:diffLayout')
})

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, i) => `const ${prefix}${i + 1} = ${i + 1}`)

// 400 lines: lines 41-60 deleted, 5 lines added after line 200, line 350 modified.
const ORIGINAL = lines(400)
const MODIFIED = [
  ...ORIGINAL.slice(0, 40),
  ...ORIGINAL.slice(60, 200),
  ...lines(5, 'brandNew'),
  ...ORIGINAL.slice(200, 349),
  'const line350 = 350 + changed',
  ...ORIGINAL.slice(350),
]

function mount(layout: 'stacked' | 'split', original: string, text: string) {
  window.localStorage.setItem('gadgets:workshop:diffLayout', layout)
  host = document.createElement('div')
  host.style.width = layout === 'split' ? '1400px' : '800px'
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    <ThemeProvider>
      <CodeDiffEditor filename="file.ts" original={original} text={text} height={500} />
    </ThemeProvider>,
  ))
}

function strip(): HTMLElement {
  const found = host!.querySelectorAll<HTMLElement>('.gadgets-diff-overview')
  // Only the chat-side (rightmost) editor gets a strip.
  expect(found).toHaveLength(1)
  return found[0]
}

const marks = (kind: string) =>
  [...strip().querySelectorAll<HTMLElement>(`.gadgets-diff-overview-${kind}`)]

function chatScroller(): HTMLElement {
  const scrollers = host!.querySelectorAll<HTMLElement>('.cm-scroller')
  return scrollers[scrollers.length - 1]
}

function inView(element: Element | null | undefined): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const view = chatScroller().getBoundingClientRect()
  return rect.bottom > view.top && rect.top < view.bottom
}

const changedLine = (text: string) =>
  [...host!.querySelectorAll('.cm-line')].find(line => line.textContent === text)

describe.each(['stacked', 'split'] as const)('the overview strip (%s)', layout => {
  const deletionZone = layout === 'stacked'
    ? '.gadgets-deleted-code-zone'
    : '.gadgets-diff-blank-zone'

  it('marks each change and scrolls to it when pressed', async () => {
    mount(layout, ORIGINAL.join('\n'), MODIFIED.join('\n'))
    await vi.waitFor(() => expect(strip().hidden).toBe(false))
    expect(marks('delete')).toHaveLength(1)
    expect(marks('add')).toHaveLength(1)
    expect(marks('modified')).toHaveLength(1)
    const top = (mark: HTMLElement) => mark.getBoundingClientRect().top
    expect(top(marks('delete')[0])).toBeLessThan(top(marks('add')[0]))
    expect(top(marks('add')[0])).toBeLessThan(top(marks('modified')[0]))

    await userEvent.click(marks('modified')[0])
    await vi.waitFor(() =>
      expect(inView(changedLine('const line350 = 350 + changed'))).toBe(true))

    await userEvent.click(marks('add')[0])
    await vi.waitFor(() => expect(inView(changedLine('const brandNew3 = 3'))).toBe(true))

    await userEvent.click(marks('delete')[0])
    await vi.waitFor(() =>
      expect(inView(chatScroller().querySelector(deletionZone))).toBe(true))
  })

  it('scrolls to a one-line change in a long file, where its mark is drawn taller', async () => {
    // At 10,000 lines one line is a small fraction of a pixel of strip, so the mark's
    // min-height covers dozens of lines; pressing it must still land on the change.
    const original = lines(10_000)
    const modified = original.with(3455, 'const line3456 = 3456 + changed')
    mount(layout, original.join('\n'), modified.join('\n'))
    await vi.waitFor(() => expect(marks('modified')).toHaveLength(1))

    await userEvent.click(marks('modified')[0])
    await vi.waitFor(() =>
      expect(inView(changedLine('const line3456 = 3456 + changed'))).toBe(true))
  })

  it('keeps the mark for a change on the last line of a long file inside the strip', async () => {
    const original = lines(10_000)
    mount(layout, original.join('\n'), [...original, 'const appended = true'].join('\n'))
    await vi.waitFor(() => expect(marks('add')).toHaveLength(1))
    const mark = marks('add')[0].getBoundingClientRect()
    expect(mark.height).toBeGreaterThanOrEqual(2)
    expect(mark.bottom).toBeLessThanOrEqual(strip().getBoundingClientRect().bottom + 0.5)

    await userEvent.click(marks('add')[0])
    await vi.waitFor(() => expect(inView(changedLine('const appended = true'))).toBe(true))
  })

  it('reaches each of two changes whose marks overlap near the end of a long file', async () => {
    // Both marks fall in the strip's last 2px; the append's is drawn on top.
    const original = lines(10_000)
    const modified = [
      ...original.with(9967, 'const line9968 = 9968 + changed'),
      'const appended = true',
    ]
    mount(layout, original.join('\n'), modified.join('\n'))
    await vi.waitFor(() => expect(marks('add')).toHaveLength(1))

    await userEvent.click(marks('add')[0])
    await vi.waitFor(() =>
      expect(inView(changedLine('const line9968 = 9968 + changed'))).toBe(true))
  })

  it('passes wheel scrolling over the strip to the editor', async () => {
    mount(layout, ORIGINAL.join('\n'), MODIFIED.join('\n'))
    await vi.waitFor(() => expect(strip().hidden).toBe(false))
    await userEvent.wheel(strip(), { delta: { y: 200 } })
    await vi.waitFor(() => expect(chatScroller().scrollTop).toBeGreaterThan(0))
  })

  it('stays clear of the Find panel', async () => {
    const original = lines(400)
    mount(layout, original.join('\n'), original.with(379, 'const line380 = 380 + changed').join('\n'))
    await vi.waitFor(() => expect(marks('modified')).toHaveLength(1))
    act(() => { openSearchPanel(EditorView.findFromDOM(chatScroller())!) })
    const panel = await vi.waitFor(() => {
      const found = host!.querySelector('.cm-search')
      expect(found).not.toBeNull()
      return found!
    })
    await vi.waitFor(() => expect(strip().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(panel.getBoundingClientRect().top + 0.5))

    // Playwright refuses to click a covered element, so this also checks the panel isn't on top.
    await userEvent.click(marks('modified')[0])
    await vi.waitFor(() =>
      expect(inView(changedLine('const line380 = 380 + changed'))).toBe(true))
  })

  it('marks no part of a replacement red when it has fewer new lines than old', async () => {
    // Lines 101-105 become three edited lines: split view pads the chat side with a blank zone.
    const original = lines(400)
    const modified = [
      ...original.slice(0, 100),
      ...original.slice(100, 103).map(line => `${line} + changed`),
      ...original.slice(105),
    ]
    mount(layout, original.join('\n'), modified.join('\n'))
    // Which new lines pair with old ones (yellow) or stand alone (green) is the word diff's
    // call, as in the gutter; the point is that no part of a replacement reads as a deletion.
    await vi.waitFor(() => expect(marks('modified').length).toBeGreaterThan(0))
    expect(marks('delete')).toHaveLength(0)
  })
})

it('hides the strip when the whole file fits', async () => {
  mount('stacked', lines(5).join('\n'), [...lines(4), 'changed'].join('\n'))
  await vi.waitFor(() => expect(host!.querySelector('.gadgets-diff-line-add')).not.toBeNull())
  expect(strip().hidden).toBe(true)
})

it('lands on a change when wrapped lines make offscreen heights estimates', async () => {
  // Phone widths wrap the chat side, so heights below the viewport are guesses until measured.
  const original = Array.from({ length: 1_000 }, (_, i) =>
    i % 2 ? `const long${i + 1} = '${'wrapped text '.repeat(30)}'` : `const short${i + 1} = 1`)
  const modified = original.with(749, 'const line750 = 750 + changed')
  window.localStorage.setItem('gadgets:workshop:diffLayout', 'stacked')
  host = document.createElement('div')
  host.style.width = '390px'
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    <ThemeProvider>
      <CodeDiffEditor
        filename="file.ts" original={original.join('\n')} text={modified.join('\n')} height={500}
      />
    </ThemeProvider>,
  ))
  await vi.waitFor(() => expect(host!.querySelector('.cm-lineWrapping')).not.toBeNull())
  await vi.waitFor(() => expect(marks('modified').length + marks('add').length).toBeGreaterThan(0))

  await userEvent.click([...marks('modified'), ...marks('add')][0])
  await vi.waitFor(() =>
    expect(inView(changedLine('const line750 = 750 + changed'))).toBe(true))
})
