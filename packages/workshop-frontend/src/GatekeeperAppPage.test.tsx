// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import GatekeeperAppPage from './GatekeeperAppPage'

const context = vi.hoisted(() => ({ authenticatedApi: { getGatekeeperApp: vi.fn<AuthenticatedApi['getGatekeeperApp']>() } }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => context }))
vi.mock('./SandboxedGatekeeperApp', () => ({ default: ({ frame }: { frame: GatekeeperUiFrame }) => <div>{frame.iframeHtml}</div> }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<() => void>() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('shows the app when a new API acquires a frame after an earlier failure', async ({ onTestFinished }) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  const root = createRoot(container)
  onTestFinished(() => { act(() => root.unmount()) })
  onTestFinished(() => { error.mockRestore() })
  context.authenticatedApi = { getGatekeeperApp: vi.fn<AuthenticatedApi['getGatekeeperApp']>().mockRejectedValue(new Error('Connection lost')) }
  await act(async () => root.render(<GatekeeperAppPage appId="example" />))
  expect(container.textContent).toContain('Connection lost')
  context.authenticatedApi = { getGatekeeperApp: vi.fn<AuthenticatedApi['getGatekeeperApp']>().mockResolvedValue({ iframeHtml: 'Example app', ui: {} as GatekeeperUiFrame['ui'] }) }
  await act(async () => root.render(<GatekeeperAppPage appId="example" />))
  expect(container.textContent).toBe('Example app')
})
