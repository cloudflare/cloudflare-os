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

const renderChip = () => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  flushSync(() => root!.render(<FocusChip focus={FOCUS} onDismiss={() => {}} />))
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

  await userEvent.keyboard('{Escape}')
  await expect.element(context()).not.toBeInTheDocument()
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: "Don't send Budget › Q3 › cell B7 with this message" }))
    .toHaveFocus()
})
