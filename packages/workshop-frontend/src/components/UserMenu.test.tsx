// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openReport: vi.fn<(context: unknown, opener: HTMLElement | null) => void>(),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
// The menu always open, an item as a button, and the trigger as the element the menu gives it.
vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" role="menuitem" onClick={onClick}>{children}</button>
      ),
      Separator: () => <hr />,
    },
  )
  return { DropdownMenu }
})
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {},
    logout: () => {},
    currentUser: { id: 'rita', name: 'Rita Reporter' },
    isAdmin: false,
  }),
}))
vi.mock('../useAvatar', () => ({ useAvatar: () => null }))
vi.mock('../features/issue-reports/ReportIssueHost', () => ({
  useReportIssue: () => mocks.openReport,
}))

import UserMenu from './UserMenu'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.openReport.mockReset()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const items = () => [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
const reportItem = () => {
  const found = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent === 'Report issue')
  if (found === undefined) throw new Error('no "Report issue" item')
  return found
}

describe('UserMenu, reporting an issue', () => {
  it('offers "Report issue" above signing out', async () => {
    await act(async () => { root.render(<UserMenu />) })
    expect(items()).toEqual(['Profile', 'Providers', 'Report issue', 'Sign out'])
  })

  it('reports from where its host says it is, and names its own trigger as the opener', async () => {
    const report = { workspace: { id: 'w1', owned: true }, chatId: 7, gadgetId: 3 }
    await act(async () => { root.render(<UserMenu report={report} />) })
    await act(async () => { reportItem().click() })

    expect(mocks.openReport).toHaveBeenCalledOnce()
    const [context, opener] = mocks.openReport.mock.calls[0]
    expect(context).toEqual({ workspace: { id: 'w1', owned: true }, chatId: 7, gadgetId: 3 })
    expect(opener).toBe(container.querySelector('button[aria-label="Open profile menu"]'))
    expect(opener).not.toBeNull()
  })

  it('reports from the home page when its host names no workspace', async () => {
    await act(async () => { root.render(<UserMenu />) })
    await act(async () => { reportItem().click() })

    expect(mocks.openReport).toHaveBeenCalledOnce()
    expect(mocks.openReport.mock.calls[0][0]).toEqual({})
  })
})
