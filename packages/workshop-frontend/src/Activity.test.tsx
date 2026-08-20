// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

import Activity from './Activity'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const testState = vi.hoisted(() => ({
  actionsById: new Map<number, ActionLogEntry>(),
  refresh: vi.fn<() => Promise<void>>(),
}))

vi.mock('@cloudflare/kumo', () => ({
  Switch: () => null,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('./useActions', () => ({
  useActions: () => ({ actionsById: testState.actionsById, isReady: true }),
}))
vi.mock('./useResolveAction', () => ({
  useResolveAction: () => vi.fn<() => Promise<void>>(),
}))
vi.mock('./useAlwaysApproveTag', () => ({
  useAlwaysApproveTag: () => ({
    alwaysApproveTag: vi.fn<() => Promise<boolean>>(),
    isTagAutoApproved: () => false,
  }),
}))
vi.mock('./useAutoApproval', () => ({
  autoApprovalKey: () => '',
  useAutoApproval: () => ({
    entries: [], isLoading: false, pending: new Set(),
    refresh: testState.refresh,
    setEnabled: vi.fn<() => Promise<void>>(),
  }),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('./useAvatar', () => ({ useAvatar: () => undefined }))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./components/GatekeeperIcon', () => ({ GatekeeperIcon: () => null }))
vi.mock('./components/HookToggle', () => ({ HookToggle: () => null }))
vi.mock('./components/ResolveButton', () => ({
  AlwaysApproveButton: () => null,
  ResolveButton: () => null,
}))
vi.mock('./components/WorkshopControls', () => ({ WorkshopButton: () => null }))
vi.mock('./components/AutoApproveConfirmDialog', () => ({ default: () => null }))

describe('Activity history', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.actionsById = new Map()
    testState.refresh.mockClear()
  })

  it('shows the reason an action was invalidated', async () => {
    testState.actionsById = new Map([[1, {
      id: 1,
      gatekeeperId: 1,
      resourceTitle: 'Issue tracker',
      createdAt: new Date(),
      appliedAt: new Date(),
      state: 'rejected',
      type: 'action',
      description: {
        title: 'Create issue',
        description: 'Creates an issue.',
        implementsRevert: false,
      },
      invalidationReason: 'The connection changed. Stage the call again.',
    }]])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Activity
        overseer={{} as RpcStub<Overseer>}
        view="history"
        onViewChange={() => {}}
      />,
    ))

    const row = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Create issue'))
    await act(async () => row!.click())

    expect(container.textContent).toContain('The connection changed. Stage the call again.')
  })

  it('refreshes auto-approval rules for out-of-order invalidations', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = () => root!.render(
      <Activity overseer={{} as RpcStub<Overseer>} view="auto" onViewChange={() => {}} />,
    )
    await act(async () => render())
    testState.refresh.mockClear()

    const firstInvalidation: ActionLogEntry = {
      id: 10,
      gatekeeperId: 1,
      resourceTitle: 'Issue tracker',
      createdAt: new Date(),
      state: 'rejected',
      type: 'action',
      description: { title: 'Create issue', description: '', implementsRevert: false },
      invalidationReason: 'Policy changed.',
    }
    testState.actionsById = new Map([[firstInvalidation.id, firstInvalidation]])
    await act(async () => render())

    expect(testState.refresh).toHaveBeenCalledOnce()

    const secondInvalidation = { ...firstInvalidation, id: 5 }
    testState.actionsById = new Map([
      [firstInvalidation.id, firstInvalidation],
      [secondInvalidation.id, secondInvalidation],
    ])
    await act(async () => render())

    expect(testState.refresh).toHaveBeenCalledTimes(2)
  })
})
