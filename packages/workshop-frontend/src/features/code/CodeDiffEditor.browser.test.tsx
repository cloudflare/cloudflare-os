/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import CodeDiffEditor from './CodeDiffEditor'
import { ThemeProvider } from '../../ThemeContext'
import '../../styles.css'

// A deleted line is laid out like the lines around it: it wraps when the editor wraps, and
// otherwise stays on one row the editor scrolls sideways to.

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = undefined
  window.localStorage.removeItem('gadgets:workshop:diffLayout')
})

const LONG_LINE = `const long = '${'wrapped text '.repeat(30)}'`

function mountDiff(width: string, original: string[], text: string[]) {
  window.localStorage.setItem('gadgets:workshop:diffLayout', 'stacked')
  host = document.createElement('div')
  host.style.width = width
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    <ThemeProvider>
      <CodeDiffEditor
        filename="file.ts" original={original.join('\n')} text={text.join('\n')} height={500}
      />
    </ThemeProvider>,
  ))
}

const mountDeletion = (width: string) =>
  mountDiff(width, ['const a = 1', LONG_LINE, 'const c = 3'], ['const a = 1', 'const c = 3'])

async function deletedRow(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const row = host!.querySelector<HTMLElement>('.gadgets-deleted-code-row')
    expect(row?.textContent).toBe(LONG_LINE)
    return row!
  })
}

const scroller = () => host!.querySelector<HTMLElement>('.cm-scroller')!

it('wraps a long deleted line in a wrapping editor, its number beside it', async () => {
  mountDeletion('390px')
  await vi.waitFor(() => expect(host!.querySelector('.cm-lineWrapping')).not.toBeNull())
  const row = await deletedRow()

  await vi.waitFor(() => expect(row.getBoundingClientRect().height).toBeGreaterThan(40))
  // All of it on screen, without widening the editor.
  expect(row.getBoundingClientRect().right)
    .toBeLessThanOrEqual(scroller().getBoundingClientRect().right + 0.5)
  expect(scroller().scrollWidth).toBe(scroller().clientWidth)

  await vi.waitFor(() => {
    const number = [...host!.querySelectorAll<HTMLElement>('.gadgets-deleted-margin')]
      .find(cell => cell.textContent === '2')
    expect(number?.getBoundingClientRect().top).toBeCloseTo(row.getBoundingClientRect().top, 0)
    expect(number?.getBoundingClientRect().height)
      .toBeCloseTo(row.getBoundingClientRect().height, 0)
  })
})

it('keeps a long deleted line on one row in a wide editor, scrolled to sideways', async () => {
  mountDeletion('800px')
  const row = await deletedRow()

  expect(host!.querySelector('.cm-lineWrapping')).toBeNull()
  expect(row.getBoundingClientRect().height).toBe(20)
  const end = scroller().scrollWidth - scroller().clientWidth
  expect(end).toBeGreaterThan(0)
  scroller().scrollLeft = end
  expect(row.getBoundingClientRect().right)
    .toBeLessThanOrEqual(scroller().getBoundingClientRect().right + 0.5)
})

it('keeps a wrapped expand button whole, its gutter cell beside it', async () => {
  // Enough deleted lines to truncate, in a pane too narrow for the button's label.
  const deleted = Array.from({ length: 130 }, (_, i) => `const gone${i + 1} = ${i + 1}`)
  mountDiff('200px', ['const a = 1', ...deleted, 'const c = 3'], ['const a = 1', 'const c = 3'])
  const button = await vi.waitFor(() => {
    const found = host!.querySelector<HTMLElement>('button.gadgets-deleted-omitted-row')
    expect(found).not.toBeNull()
    return found!
  })
  button.scrollIntoView({ block: 'center' })

  await vi.waitFor(() => expect(button.getBoundingClientRect().height).toBeGreaterThan(20))
  // The whole label is inside the button, so every part of it expands the deletion.
  expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight)
  await vi.waitFor(() => {
    const ellipsis = [...host!.querySelectorAll<HTMLElement>('.gadgets-deleted-margin')]
      .find(cell => cell.textContent === '...')
    expect(ellipsis?.getBoundingClientRect().top)
      .toBeCloseTo(button.getBoundingClientRect().top, 0)
    expect(ellipsis?.getBoundingClientRect().height)
      .toBeCloseTo(button.getBoundingClientRect().height, 0)
  })
})
