// @vitest-environment jsdom
import React, { act, lazy, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import WorkbenchLoadBoundary from './WorkbenchLoadBoundary'

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.textContent = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('contains a rejected import without navigating or discarding sibling drafts, and reloads only on click', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const location = { href: 'https://odie.example/sessions?session=current#agent', reload: vi.fn<Location['reload']>() }
  vi.stubGlobal('window', new Proxy(window, {
    get(target, property) { return property === 'location' ? location : Reflect.get(target, property) },
  }))
  const Broken = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <React.Fragment>
      <textarea defaultValue="Unsent draft" />
      <WorkbenchLoadBoundary>
        <Suspense fallback="Loading…"><Broken /></Suspense>
      </WorkbenchLoadBoundary>
    </React.Fragment>,
  ))

  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load the agent workbench.')
  expect(container.textContent).toContain('Reloading may lose unsent messages and unsaved changes.')
  expect(container.querySelector('textarea')?.value).toBe('Unsent draft')
  expect(location.href).toBe('https://odie.example/sessions?session=current#agent')
  expect(location.reload).not.toHaveBeenCalled()

  await act(async () => container.querySelector('button')!.click())
  expect(location.reload).toHaveBeenCalledOnce()
})
