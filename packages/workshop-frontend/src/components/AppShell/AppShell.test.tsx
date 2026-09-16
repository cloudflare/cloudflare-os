// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/' }))

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

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('gives the percentage-height desktop sidebar a definite-height container', () => {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<AppShell><div /></AppShell>))

    const sidebarContainer = container.querySelector('[data-testid="sidebar"]')?.parentElement
    expect(sidebarContainer?.classList.contains('h-full')).toBe(true)
  })
})
