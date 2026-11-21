// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  // Replaced before each test: the count is kept with the session that read it, so a fresh
  // session starts each test without the last one's count.
  authenticatedApi: { getUnseenIssueReportCount: (): Promise<number> => Promise.resolve(0) },
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))

import { MyIssuesSummary } from './MyIssuesSummary'
import { useIssueReportCount } from './useIssueReportCount'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const getCount = vi.fn<() => Promise<number>>()
let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  getCount.mockReset().mockResolvedValue(0)
  mocks.authenticatedApi = { getUnseenIssueReportCount: getCount }
  // The router restores scroll through window.scrollTo, which jsdom does not implement.
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Something else on the page that changes the count, as filing a report does.
const Filer = () => {
  const { refresh } = useIssueReportCount()
  return <button type="button" onClick={refresh}>File</button>
}

const render = async (collapsed = false) => {
  const rootRoute = createRootRoute({
    component: () => <><MyIssuesSummary collapsed={collapsed} /><Filer /><Outlet /></>,
  })
  const issues = createRoute({ getParentRoute: () => rootRoute, path: '/issues', component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([issues]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
}

const link = () => container!.querySelector<HTMLAnchorElement>('a[href="/issues"]')!
const badge = () => link().querySelector('[role="img"]')

it('links to My issues with the count of reports that hold a new reply', async () => {
  getCount.mockResolvedValue(2)
  await render()

  expect(link().textContent).toBe('My issues2')
  expect(badge()?.getAttribute('aria-label')).toBe('2 issues have a new reply')
  expect(getCount).toHaveBeenCalledOnce()
})

it('names a single report in the singular', async () => {
  getCount.mockResolvedValue(1)
  await render()

  expect(badge()?.getAttribute('aria-label')).toBe('1 issue has a new reply')
})

it('shows no badge for a count of zero', async () => {
  await render()

  expect(link().textContent).toBe('My issues')
  expect(badge()).toBeNull()
})

it('reads the count again when the window regains focus', async () => {
  await render()
  getCount.mockResolvedValue(3)

  await act(async () => { window.dispatchEvent(new Event('focus')) })

  expect(getCount).toHaveBeenCalledTimes(2)
  expect(link().textContent).toBe('My issues3')
})

it('reads the count again when another part of the page asks', async () => {
  await render()
  getCount.mockResolvedValue(1)

  await act(async () => { container!.querySelector('button')!.click() })

  expect(getCount).toHaveBeenCalledTimes(2)
  expect(link().textContent).toBe('My issues1')
})

it('reads the count every minute while the document is visible, and not while it is hidden', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await render()

  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(getCount).toHaveBeenCalledTimes(2)

  visibility.mockReturnValue('hidden')
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
  expect(getCount).toHaveBeenCalledTimes(2)

  visibility.mockReturnValue('visible')
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(getCount).toHaveBeenCalledTimes(3)
})

it('stops reading once it is unmounted', async () => {
  vi.useFakeTimers()
  await render()
  await act(async () => root?.unmount())
  root = undefined

  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(120_000)

  expect(getCount).toHaveBeenCalledOnce()
})

it('keeps the count it last showed when a read fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  getCount.mockResolvedValue(2)
  await render()
  getCount.mockRejectedValue(new Error('Unavailable'))

  await act(async () => { window.dispatchEvent(new Event('focus')) })

  expect(link().textContent).toBe('My issues2')
})

it('drops an answer that a later read overtook', async () => {
  await render()
  const slow = Promise.withResolvers<number>()
  getCount.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(4)

  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(link().textContent).toBe('My issues4')

  await act(async () => { slow.resolve(9) })
  expect(link().textContent).toBe('My issues4')
})

it('shows no count read over another session', async () => {
  getCount.mockResolvedValue(2)
  await render()
  await act(async () => root?.unmount())
  container?.remove()

  // Another session, whose own read has not answered.
  mocks.authenticatedApi = { getUnseenIssueReportCount: () => new Promise<number>(() => {}) }
  await render()

  expect(link().textContent).toBe('My issues')
})
