// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { button, click, deferred } from './spacesTestUtils'

// A page with a link, a field, and a button that goes once its action has worked.
const Harness = ({ action }: { action: () => Promise<void> }) => {
  const [done, setDone] = useState(false)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const settled = useFocusAfterAction(() => takeLostFocus(linkRef.current))
  const run = async () => {
    try {
      await action()
      setDone(true)
    } catch {
      // A failed action leaves the button where it is.
    } finally {
      settled()
    }
  }
  return (
    <>
      <a ref={linkRef} href="/somewhere">Somewhere</a>
      <input aria-label="Elsewhere" />
      {!done && <button type="button" onClick={() => void run()}>Act</button>}
    </>
  )
}

let root: Root | null = null

const render = async (action: () => Promise<void>) => {
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  const draw = () => act(async () => root!.render(<Harness action={action} />))
  await draw()
  return draw
}

const link = () => document.body.querySelector('a')

describe('useFocusAfterAction', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  it('leaves the focus alone until an action has settled', async () => {
    await render(async () => {})

    expect(document.activeElement).toBe(document.body)
  })

  it('gives the focus of a control that its action removed to what the caller names', async () => {
    await render(async () => {})
    button('Act').focus()

    await click(button('Act'))

    expect(document.body.querySelector('button')).toBeNull()
    expect(document.activeElement).toBe(link())
  })

  it('leaves the focus on a control that is still there', async () => {
    await render(async () => { throw new Error('Refused.') })
    button('Act').focus()

    await click(button('Act'))

    expect(document.activeElement).toBe(button('Act'))
  })

  it('leaves the focus where the user has put it meanwhile', async () => {
    const answer = deferred<void>()
    await render(() => answer.promise)
    button('Act').focus()
    await click(button('Act'))

    const elsewhere = document.body.querySelector('input')!
    elsewhere.focus()
    await act(async () => answer.resolve())

    expect(document.body.querySelector('button')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('moves nothing on a later render', async () => {
    const draw = await render(async () => {})
    button('Act').focus()
    await click(button('Act'))
    expect(document.activeElement).toBe(link())

    link()!.blur()
    await draw()

    expect(document.activeElement).toBe(document.body)
  })
})
