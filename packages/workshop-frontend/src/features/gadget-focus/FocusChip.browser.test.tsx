/* eslint-disable react/react-in-jsx-scope */

// The composer's focus chip in Chromium: whether a tap opens its details is a matter of real touch
// input, which jsdom does not model.

import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { FocusChip } from './FocusChip'
import '../../styles.css'

const FOCUS = {
  gadgetId: 3,
  gadgetTitle: 'Budget',
  spot: { anchor: 'sheet/q3/cell/B7', label: 'Q3 › cell B7', context: '1,204,331' },
}

let root: Root | undefined
let container: HTMLElement | undefined

// Importing Playwright's CDP augmentation would add Node globals to the browser TS project.
const sendCdp = async (method: string, params: object) => {
  const session = cdp()
  if (!('send' in session) || typeof session.send !== 'function') {
    throw new Error('Native touch coverage requires Chromium CDP.')
  }
  await session.send(method, params)
}

afterEach(async () => {
  root?.unmount()
  container?.remove()
  await sendCdp('Emulation.setTouchEmulationEnabled', { enabled: false })
})

const renderChip = (focus = FOCUS) => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  flushSync(() => root!.render(<FocusChip focus={focus} onDismiss={() => {}} />))
}

// Its coordinates are in the outer page, not Vitest's test iframe.
const touch = async (element: Element) => {
  const box = element.getBoundingClientRect()
  let x = box.left + box.width / 2
  let y = box.top + box.height / 2
  let frame: Window = window
  while (frame.frameElement) {
    const frameBox = frame.frameElement.getBoundingClientRect()
    x = frameBox.left + x * frameBox.width / frame.innerWidth
    y = frameBox.top + y * frameBox.height / frame.innerHeight
    frame = frame.parent
  }
  await sendCdp('Emulation.setTouchEmulationEnabled', { enabled: true })
  await sendCdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await sendCdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const chip = () => page.getByRole('button', { name: 'Budget › Q3 › cell B7' })
const context = () => page.getByText('1,204,331')

it('shows the context on a tap', async () => {
  renderChip()
  await touch(chip().element())
  await expect.element(context()).toBeVisible()
})

it('shows the context from the keyboard, with dismissing a separate stop', async () => {
  renderChip()
  await userEvent.tab()
  await expect.element(chip()).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(context()).toBeVisible()
  await expect.element(page.getByRole('dialog', {
    name: "The agent will be told you're viewing Budget › Q3 › cell B7",
  })).toBeInTheDocument()

  await userEvent.keyboard('{Escape}')
  await expect.element(context()).not.toBeInTheDocument()
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: "Don't send Budget › Q3 › cell B7 with this message" }))
    .toHaveFocus()
})

it('lets a long context be scrolled to its end, since all of it is sent', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Row ${i + 1}`)
  renderChip({ ...FOCUS, spot: { ...FOCUS.spot, context: lines.join('\n') } })
  await userEvent.click(chip())
  const description = page.getByText(/^Row 1\n/).element() as HTMLElement
  expect(description.textContent).toContain('Row 40')
  expect(description.scrollHeight).toBeGreaterThan(description.clientHeight)
  description.scrollTop = description.scrollHeight
  expect(description.scrollTop + description.clientHeight).toBeGreaterThanOrEqual(description.scrollHeight - 1)
})
