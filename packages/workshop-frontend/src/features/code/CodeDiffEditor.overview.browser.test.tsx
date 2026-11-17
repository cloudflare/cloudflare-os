/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
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
})

it('hides the strip when the whole file fits', async () => {
  mount('stacked', lines(5).join('\n'), [...lines(4), 'changed'].join('\n'))
  await vi.waitFor(() => expect(host!.querySelector('.gadgets-diff-line-add')).not.toBeNull())
  expect(strip().hidden).toBe(true)
})
