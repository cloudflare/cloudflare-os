// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => {
  const held = {
    openReport: vi.fn<(context: unknown, opener: HTMLElement | null) => void>(),
    workspaces: [] as unknown[],
    // One object for every render: the list loads again whenever its API changes.
    authenticatedApi: {
      whoami: async () => ({ type: 'user', id: 'rita', name: 'Rita Reporter' }),
      listWorkspaces: async () => held.workspaces,
    },
  }
  return held
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params: { id: string } }) => (
    <a href={`/workspace/${params.id}`}>{children}</a>
  ),
}))
// Each row's menu always open, an item as a button, and the trigger as the element the row
// gives it. The list's own dialog is left out.
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
  const Dialog = Object.assign(() => null, { Root: () => null })
  return { DropdownMenu, Dialog, Button: () => null, useKumoToastManager: () => ({ add: () => {} }) }
})
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('../features/notifications/UnreadStateBridge', () => ({ useUnreadState: () => null }))
vi.mock('../features/notifications/UnreadBadge', () => ({ UnreadBadge: () => null }))
vi.mock('../features/notifications/WorkspaceNotificationsMenu', () => ({
  WorkspaceNotificationsMenu: () => null,
}))
vi.mock('../features/issue-reports/ReportIssueHost', () => ({
  useReportIssue: () => mocks.openReport,
}))
vi.mock('../ShareModal', () => ({ default: () => null }))
vi.mock('./DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./BlueprintCard', () => ({
  BindingBadge: () => null,
  getGradient: () => '',
  uniqueBindingBadges: () => [],
}))
vi.mock('./BlueprintPreviewImage', () => ({ BlueprintPreviewImage: () => null }))

import GadgetList from './GadgetList'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const workspace = (
  id: string,
  title: string,
  lastActive: string,
  change: Partial<WorkspaceMetadataWithTimestamps> = {},
): WorkspaceMetadataWithTimestamps => ({
  id,
  title,
  created: new Date('2026-10-01T00:00:00Z'),
  lastActive: new Date(lastActive),
  ...change,
} as WorkspaceMetadataWithTimestamps)

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

describe('GadgetList, reporting an issue from a workspace’s row', () => {
  it('reports from that workspace, says whether the user owns it, and names the row’s own menu button', async () => {
    // Newest first: the workspace the user owns, then one shared with them.
    mocks.workspaces = [
      workspace('mine', 'Trips', '2026-10-12T00:00:00Z'),
      workspace('theirs', 'Budget', '2026-10-11T00:00:00Z', {
        owner: { type: 'user', id: 'olga', name: 'Olga Owner' },
        role: 'build',
      }),
    ]
    await act(async () => { root.render(<GadgetList />) })

    const rows = [...container.querySelectorAll('a')]
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/workspace/mine', '/workspace/theirs'])
    const reportItems = rows.map((row) => {
      const found = [...row.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .filter((item) => item.textContent === 'Report issue')
      expect(found).toHaveLength(1)
      return found[0]
    })
    const menuButtons = rows.map((row) => row.querySelector('button[aria-label="Workspace actions"]'))
    expect(menuButtons[0]).not.toBeNull()
    expect(menuButtons[1]).not.toBeNull()

    await act(async () => { reportItems[0].click() })
    expect(mocks.openReport).toHaveBeenCalledOnce()
    expect(mocks.openReport.mock.calls[0][0]).toEqual({ workspace: { id: 'mine', owned: true } })
    expect(mocks.openReport.mock.calls[0][1]).toBe(menuButtons[0])

    await act(async () => { reportItems[1].click() })
    expect(mocks.openReport).toHaveBeenCalledTimes(2)
    expect(mocks.openReport.mock.calls[1][0]).toEqual({ workspace: { id: 'theirs', owned: false } })
    expect(mocks.openReport.mock.calls[1][1]).toBe(menuButtons[1])
  })
})
