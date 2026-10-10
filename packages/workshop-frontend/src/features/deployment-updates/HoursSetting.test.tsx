// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_UPDATE_HOURS } from '@gadgets/workshop-shared/api'
import { HoursSetting } from './HoursSetting'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const LABEL = 'Minimum release age (hours)'

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const focus = (element: HTMLElement) => act(async () => { element.focus() })

// What a browser does to a control with focus that a save disables. jsdom leaves focus on such a
// control and won't blur it either, so focus leaves by way of a button that takes it and goes.
const dropFocus = () => act(async () => {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.blur()
  elsewhere.remove()
})

describe('HoursSetting', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (hours = 24) => {
    const onSave = vi.fn<(hours: number) => Promise<boolean>>(async () => true)
    // Shows the hours a re-read reported.
    const show = (reported: number) => act(async () => root.render(
      <HoursSetting label={LABEL} help="What the hours mean." hours={reported} onSave={onSave} />))
    await show(hours)
    return { onSave, show }
  }

  const input = () => {
    const labelElement = [...container.querySelectorAll('label')]
      .find((element) => element.textContent?.startsWith(LABEL))
    const element = labelElement && document.getElementById(labelElement.htmlFor)
    if (!(element instanceof HTMLInputElement)) throw new Error(`no input labeled ${LABEL}`)
    return element
  }

  const saveButton = () => {
    const element = [...container.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === `Save “${LABEL}”`)
    if (!element) throw new Error('no Save button')
    return element
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the hours a re-read after a save reported, not what was typed', async () => {
    const { onSave, show } = await render()

    await type(input(), '048')
    await click(saveButton())
    expect(onSave).toHaveBeenCalledExactlyOnceWith(48)

    // Another admin's change, say, landed between the save and the re-read.
    await show(50)
    expect(input().value).toBe('50')
  })

  it.each([
    String(MAX_UPDATE_HOURS + 1),
    '1.5',
    '-1',
    '',
    'twelve',
    '1e2',
  ])('refuses %j in the field without a call', async (hours) => {
    const { onSave } = await render()

    await type(input(), hours)

    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain(`Enter a whole number of hours from 0 to ${MAX_UPDATE_HOURS}`)

    await click(saveButton())

    expect(onSave).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input())
  })

  it('makes no call for the hours the server already holds', async () => {
    const { onSave } = await render(24)

    await type(input(), '24')
    await click(saveButton())

    expect(onSave).not.toHaveBeenCalled()
  })

  it('is disabled while its save is in flight', async () => {
    const { onSave } = await render()
    const call = deferred<boolean>()
    onSave.mockReturnValueOnce(call.promise)

    await type(input(), '48')
    await click(saveButton())

    expect(input().disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
    await click(saveButton())
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => call.resolve(true))

    expect(input().disabled).toBe(false)
    expect(saveButton().disabled).toBe(false)
  })

  it('keeps what was typed after a save or re-read that failed', async () => {
    const { onSave } = await render()
    onSave.mockResolvedValueOnce(false)

    await type(input(), '48')
    await click(saveButton())

    expect(input().value).toBe('48')
    expect(input().disabled).toBe(false)
  })

  // The field and its button are disabled for as long as a save takes, and a disabled control
  // loses focus.
  describe('focus across a save', () => {
    it('returns to the Save button that was pressed', async () => {
      const { onSave } = await render()
      const call = deferred<boolean>()
      onSave.mockReturnValueOnce(call.promise)
      await type(input(), '48')

      await focus(saveButton())
      await click(saveButton())
      await dropFocus()
      expect(saveButton().disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve(true))

      expect(document.activeElement).toBe(saveButton())
    })

    it('returns to the field a save was submitted from', async () => {
      const { onSave } = await render()
      const call = deferred<boolean>()
      onSave.mockReturnValueOnce(call.promise)
      await type(input(), '48')

      await focus(input())
      await act(async () => input().form!.requestSubmit())
      await dropFocus()
      expect(input().disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve(false))

      expect(document.activeElement).toBe(input())
    })

    it('leaves focus where it was moved to while the save was in flight', async () => {
      const { onSave } = await render()
      const call = deferred<boolean>()
      onSave.mockReturnValueOnce(call.promise)
      const elsewhere = document.body.appendChild(document.createElement('button'))
      await type(input(), '48')
      await focus(saveButton())
      await click(saveButton())
      await dropFocus()

      await focus(elsewhere)
      await act(async () => call.resolve(true))

      expect(document.activeElement).toBe(elsewhere)
      elsewhere.remove()
    })
  })
})
