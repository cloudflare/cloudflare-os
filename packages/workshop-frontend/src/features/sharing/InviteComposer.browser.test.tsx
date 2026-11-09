/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty } from '@cloudflare/kumo'
import { RpcPromise, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, Overseer, ServerConfig, UserDirectoryRecord, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import '../../styles.css'
import { ServerConfigContext } from '../../ServerConfigContext'
import { WorkspaceInviteModal } from './WorkspaceInviteModal'

vi.mock('../../components/PersonAvatar', () => ({ PersonAvatar: () => null }))

let root: Root | undefined
let container: HTMLElement | undefined
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it.each([
  { name: 'with directory search', searchEnabled: true },
  { name: 'without directory search', searchEnabled: false },
])('marks the field invalid when no account matches, $name', async ({ searchEnabled }) => {
  const overseer = {
    listCollaborators: async () => [],
    listObserverRequirements: async () => [],
    addCollaborator: async () => null,
  } as unknown as RpcStub<Overseer>
  const authenticatedApi = {
    searchUsers: () => new RpcPromise(Promise.resolve<UserDirectoryRecord[]>([])),
    listGatekeeperVendors: async () => [],
    listAddableGatekeepers: async () => [],
  } as unknown as RpcStub<AuthenticatedApi>
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <Toasty><ServerConfigContext.Provider value={{ userSearchEnabled: searchEnabled } as ServerConfig}>
      <WorkspaceInviteModal open onClose={() => {}} overseer={overseer}
        metadata={{ id: 'workspace-1', title: 'Workspace', kind: 'workspace' } as WorkspaceMetadata}
        currentUser={{ type: 'user', id: 'owner@example.com', name: 'Owner' }}
        authenticatedApi={authenticatedApi} />
    </ServerConfigContext.Provider></Toasty>,
  ))
  const field = page.getByRole('combobox', { name: searchEnabled ? 'Search people' : 'Username or email' })
  await input(() => userEvent.fill(field, 'ghost@example.com'))
  await input(() => new Promise(resolve => setTimeout(resolve, 300)))
  await input(() => userEvent.click(page.getByRole('button', { name: 'Invite', exact: true }).first()))
  await expect.element(page.getByText('No account found for that username or email.')).toBeVisible()
  await expect.element(field).toHaveAttribute('aria-invalid', 'true')
})
