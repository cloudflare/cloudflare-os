// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Kumo from '@cloudflare/kumo'
import type { NotificationMute } from '@gadgets/workshop-shared/api'

const { api, addToast } = vi.hoisted(() => ({
  api: {
    setWorkspaceNotificationMute:
      vi.fn<(workspaceId: string, mute: NotificationMute | null) => Promise<void>>(),
  },
  addToast: vi.fn<(toast: { variant?: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api }),
}))

import { WorkspaceNotificationsMenu } from './WorkspaceNotificationsMenu'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

// 9:30 PM local time, half an hour after an earlier mute ended.
const NOW = new Date(2026, 9, 15, 21, 30)
const ENDED: NotificationMute = { until: new Date(2026, 9, 15, 21, 0) }

// Owns the workspace's mute as the sidebar and workspace list do.
const WorkspaceMenu = () => {
  const [mute, setMute] = useState<NotificationMute | undefined>(ENDED)
  return (
    <Kumo.DropdownMenu>
      <Kumo.DropdownMenu.Trigger render={<button type="button">Workspace actions</button>} />
      <Kumo.DropdownMenu.Content>
        <WorkspaceNotificationsMenu workspaceId="workspace-1" mute={mute} onMuteChange={setMute} />
      </Kumo.DropdownMenu.Content>
    </Kumo.DropdownMenu>
  )
}

const byText = (selector: string, text: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
  .find(element => element.textContent?.trim() === text)

/** Opens the workspace menu and returns its notification item's label. */
const openMenu = async () => {
  await act(async () => byText('button', 'Workspace actions')!.click())
  return [...document.body.querySelectorAll('[role="menuitem"]')]
    .map(item => item.textContent?.trim())
    .find(label => label && /mute notifications$/i.test(label))
}

let root: Root | undefined

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root!.render(<WorkspaceMenu />))
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})

it('mutes until local midnight, and unmutes once muted', async () => {
  expect(await openMenu()).toBe('Mute notifications')
  await act(async () => byText('[role="menuitem"]', 'Mute notifications')!.click())
  await act(async () => byText('[role="menuitem"]', 'Until end of day')!.click())
  expect(api.setWorkspaceNotificationMute)
    .toHaveBeenCalledWith('workspace-1', { until: new Date(2026, 9, 16) })

  expect(await openMenu()).toBe('Unmute notifications')
  await act(async () => byText('[role="menuitem"]', 'Unmute notifications')!.click())
  expect(api.setWorkspaceNotificationMute).toHaveBeenLastCalledWith('workspace-1', null)
  expect(await openMenu()).toBe('Mute notifications')
})

it('stays unmuted when the mute fails to save', async () => {
  using _ = vi.spyOn(console, 'error').mockImplementation(() => {})
  api.setWorkspaceNotificationMute.mockRejectedValueOnce(new Error('offline'))
  await openMenu()
  await act(async () => byText('[role="menuitem"]', 'Mute notifications')!.click())
  await act(async () => byText('[role="menuitem"]', 'Until I turn it back on')!.click())
  expect(api.setWorkspaceNotificationMute).toHaveBeenLastCalledWith('workspace-1', { indefinite: true })
  expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
  expect(await openMenu()).toBe('Mute notifications')
})
