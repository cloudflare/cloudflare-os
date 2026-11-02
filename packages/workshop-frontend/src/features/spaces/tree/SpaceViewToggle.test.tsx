// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { click, fakeApi, mount, settle, unmountAll } from '../spacesTestUtils'
import { SpaceViewToggle } from './SpaceViewToggle'
import { useSpaceViewMode, type SpaceViewMode } from './useSpaceViewMode'

// jsdom has neither ResizeObserver nor scrollIntoView, which Kumo's tabs use to place their
// indicator and to bring a chosen tab into view.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  unmountAll()
  localStorage.clear()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')]
const tab = (name: string) => tabs().find(candidate => candidate.textContent === name)!
const selected = () => tabs().filter(candidate => candidate.getAttribute('aria-selected') === 'true')
  .map(candidate => candidate.textContent)

const press = (key: string) => act(async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
})

const Remembered = () => {
  const [mode, setMode] = useSpaceViewMode()
  return <SpaceViewToggle mode={mode} onModeChange={setMode} />
}

describe('SpaceViewToggle', () => {
  it('names the choice and marks the current view', async () => {
    await mount(<SpaceViewToggle mode="tree" onModeChange={() => {}} />, fakeApi())

    const group = document.body.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('View')
    expect(group.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs().map(candidate => candidate.textContent)).toEqual(['List', 'Tree'])
    expect(selected()).toEqual(['Tree'])
  })

  it('asks for the view chosen by pointer or by keyboard', async () => {
    const onModeChange = vi.fn<(mode: SpaceViewMode) => void>()
    const Controlled = () => {
      const [mode, setMode] = useState<SpaceViewMode>('list')
      return (
        <SpaceViewToggle
          mode={mode}
          onModeChange={(next) => {
            onModeChange(next)
            setMode(next)
          }}
        />
      )
    }
    await mount(<Controlled />, fakeApi())

    await click(tab('Tree'))
    expect(onModeChange).toHaveBeenLastCalledWith('tree')
    expect(selected()).toEqual(['Tree'])

    await act(async () => tab('Tree').focus())
    await press('ArrowLeft')
    expect(document.activeElement).toBe(tab('List'))
    // Enter or Space presses the focused tab, a native button, which the browser turns into a
    // click and jsdom does not.
    await click(document.activeElement as HTMLElement)
    expect(onModeChange).toHaveBeenLastCalledWith('list')
    expect(selected()).toEqual(['List'])
  })

  it('remembers the view chosen with it', async () => {
    await mount(<Remembered />, fakeApi())
    await settle()
    await click(tab('Tree'))
    unmountAll()

    await mount(<Remembered />, fakeApi())
    await settle()
    expect(selected()).toEqual(['Tree'])
  })
})
