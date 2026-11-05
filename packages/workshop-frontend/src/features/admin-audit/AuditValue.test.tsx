// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditValue } from './AuditValue'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

describe('AuditValue', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (value: string | undefined) => act(() => root.render(<AuditValue value={value} label="siteName, before" />))
  const toggle = () => container.querySelector('button')

  it('shows a short value whole, with no toggle', async () => {
    await render('Acme Workshop')
    expect(container.textContent).toBe('Acme Workshop')
    expect(toggle()).toBeNull()
  })

  it('clamps a long value, and shows it whole from a keyboard-operable toggle', async () => {
    const long = 'x'.repeat(500)
    await render(long)
    const value = document.getElementById(toggle()!.getAttribute('aria-controls')!)
    expect(value?.textContent).toBe(long)
    expect(value?.className).toContain('line-clamp-3')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
    expect(toggle()!.getAttribute('aria-label')).toBe('Show all of siteName, before')

    await act(async () => { toggle()!.click() })
    expect(toggle()!.textContent).toBe('Show less')
    expect(toggle()!.getAttribute('aria-label')).toBe('Show less of siteName, before')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    expect(value?.className).not.toContain('line-clamp-3')
  })

  it('treats a value of more lines than the clamp as long', async () => {
    await render('a\nb\nc\nd')
    expect(toggle()?.textContent).toBe('Show all')
  })

  it('announces an absent side as none', async () => {
    await render(undefined)
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('—')
    expect(container.querySelector('.sr-only')?.textContent).toBe('none')
  })
})
