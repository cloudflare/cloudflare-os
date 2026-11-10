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

// The `spaces` flag as the shell reads it: a test sets it and renders again.
const flags = vi.hoisted(() => ({ spaces: true }))
vi.mock('../../FeatureFlagsContext', () => ({
  useUiFeatureFlag: (name: 'spaces') => ({ enabled: flags[name], loading: false }),
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

  // Whether the drawer is on show, and whether the page's column is covered, which go together.
  const shell = () => ({ drawer: drawer() !== null, covered: coveredColumn() !== null })
  const OPEN = { drawer: true, covered: true }
  const CLOSED = { drawer: false, covered: false }

  // The shell at `at` with its drawer opened, and still open after a render that moves nowhere.
  const renderWithDrawerOpen = (at: string) => {
    goTo(at)
    container = document.createElement('div')
    root = createRoot(container)
    render()
    act(() => container!.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!.click())
    render()
    expect(shell()).toEqual(OPEN)
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    goTo('/')
    flags.spaces = true
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
    // As the Home link does on Home, when the URL there names a space.
    ['that changes only the search', '/?space=design', '/'],
  ])('closes the mobile drawer on a navigation %s', (_kind, from, to) => {
    renderWithDrawerOpen(from)

    goTo(to)
    render()

    expect(shell()).toEqual(CLOSED)
  })

  it('closes the mobile drawer on a navigation to another page with the spaces flag off', () => {
    flags.spaces = false
    renderWithDrawerOpen('/workspaces')

    goTo('/blueprints')
    render()

    expect(shell()).toEqual(CLOSED)
  })

  it('leaves the mobile drawer open through a navigation that changes only the search with the spaces flag off', () => {
    flags.spaces = false
    renderWithDrawerOpen('/?space=design')

    goTo('/')
    render()

    expect(shell()).toEqual(OPEN)
  })

  it('leaves the mobile drawer open when the value of the spaces flag arrives', () => {
    flags.spaces = false
    renderWithDrawerOpen('/?space=design')

    flags.spaces = true
    render()

    expect(shell()).toEqual(OPEN)
  })

  it('leaves the mobile drawer open when the spaces flag goes unknown and comes back', () => {
    renderWithDrawerOpen('/?space=design')

    // A replaced session's flags read as off until they load.
    flags.spaces = false
    render()
    expect(shell()).toEqual(OPEN)
    flags.spaces = true
    render()
    expect(shell()).toEqual(OPEN)

    // The flag is on again, and a change of the search alone counts with it.
    goTo('/')
    render()
    expect(shell()).toEqual(CLOSED)
  })
})
