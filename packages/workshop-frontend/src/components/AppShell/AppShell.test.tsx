// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Where the router is: a test moves it with `goTo` and renders again.
const routerState = vi.hoisted(() => ({ location: { pathname: '/', href: '/' } }))
const goTo = (href: string) => {
  routerState.location = { pathname: href.split('?')[0], href }
}

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: typeof routerState) => unknown }) => select(routerState),
}))

vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('./CommandPalette', () => ({ default: () => null }))
vi.mock('./Sidebar', () => ({
  default: () => <aside data-testid="sidebar" />,
}))

import AppShell from './AppShell'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppShell', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const render = () => act(() => root!.render(<AppShell><div /></AppShell>))

  const drawer = () => container!.querySelector('[role="dialog"][aria-label="Primary navigation"]')
  // The page's column while the drawer covers it.
  const coveredColumn = () => container!.querySelector('[aria-hidden="true"][inert]')

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    goTo('/')
  })

  it('gives the percentage-height desktop sidebar a definite-height container', () => {
    container = document.createElement('div')
    root = createRoot(container)
    render()

    const sidebarContainer = container.querySelector('[data-testid="sidebar"]')?.parentElement
    expect(sidebarContainer?.classList.contains('h-full')).toBe(true)
  })

  it.each([
    ['to another page', '/workspaces', '/blueprints'],
    // As a link to a part of the page the user is already on.
    ['that changes only the search', '/workspaces', '/workspaces?space=design'],
  ])('closes the mobile drawer on a navigation %s', (_kind, from, to) => {
    goTo(from)
    container = document.createElement('div')
    root = createRoot(container)
    render()
    act(() => container!.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!.click())
    // The drawer stays open through a render that moves nowhere.
    render()
    expect(drawer()).not.toBeNull()
    expect(coveredColumn()).not.toBeNull()

    goTo(to)
    render()

    expect(drawer()).toBeNull()
    expect(coveredColumn()).toBeNull()
  })
})
