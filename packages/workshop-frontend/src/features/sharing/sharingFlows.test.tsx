// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcPromise, type RpcStub } from 'capnweb'
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorAccess,
  CollaboratorGrant,
  CollaboratorInfo,
  ObserverBindingNeed,
  Overseer,
  PermissionEdge,
  ServerConfig,
  UserDirectoryRecord,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { WorkspaceInviteModal } from './WorkspaceInviteModal'
import { GadgetShareModal } from './GadgetShareModal'

const { toastAdd, copyToClipboard } = vi.hoisted(() => ({ toastAdd: vi.fn<(toast: unknown) => void>(), copyToClipboard: vi.fn<(text: string) => Promise<boolean>>(async () => true) }))
vi.mock('../../clipboard', () => ({ copyToClipboard }))
vi.mock('../../components/PersonAvatar', () => ({ PersonAvatar: () => <span /> }))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    // Keep a fresh manager object each render, as the real Kumo hook does.
    useKumoToastManager: () => ({ add: toastAdd }),
    Dialog: Object.assign(({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>, {
      Root: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({}),
    }),
    DropdownMenu: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
    }),
  }
})

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'owner@example.com', name: 'Owner' }
const METADATA = { id: 'workspace-1', title: 'Workspace' } as WorkspaceMetadata
// Gadget id 0 catches code that tests the id for truthiness instead of presence.
const GADGET = { id: 0, title: 'My Application' }
const CREATED = new Date('2026-08-01T00:00:00Z')

const accessFor = (grant: CollaboratorGrant): CollaboratorAccess =>
  grant === 'workspace' ? { role: 'build' } : { role: 'use', gadgetIds: [grant.gadgetId] }
const userEdge = (sharer: string, grant: CollaboratorGrant): PermissionEdge => grant === 'workspace'
  ? { type: 'user', sharer, created: CREATED, role: 'build' }
  : { type: 'user', sharer, created: CREATED, role: 'use', gadgetId: grant.gadgetId }
const person = (id: string, name: string, grant: CollaboratorGrant = 'workspace', sharer = OWNER.id): CollaboratorInfo => ({
  profile: { type: 'user', id, name }, access: accessFor(grant), addedBy: [userEdge(sharer, grant)],
})
const affected = (info: CollaboratorInfo): AffectedCollaborator => ({ ...info, oldAccess: info.access, newAccess: null })

const ALICE = person('alice', 'Alice')
// Holds the dialog's gadget and one other.
const GUS: CollaboratorInfo = {
  profile: { type: 'user', id: 'gus', name: 'Gus' },
  access: { role: 'use', gadgetIds: [0, 1] },
  addedBy: [userEdge(OWNER.id, { gadgetId: 0 }), userEdge(OWNER.id, { gadgetId: 1 })],
}
const HAL = person('hal', 'Hal', { gadgetId: 1 })
// Granted every gadget before gadgets were shared individually.
const LEE: CollaboratorInfo = {
  profile: { type: 'user', id: 'lee', name: 'Lee' },
  access: { role: 'use', gadgetIds: 'all' },
  addedBy: [{ type: 'user', sharer: OWNER.id, created: CREATED, role: 'use' }],
}
const REQUIREMENT: ObserverBindingNeed = { gatekeeperId: 7, vendorId: 'google', resourceTitle: 'Q3 planning' }

const makeApi = () => ({
  listCollaborators: vi.fn<Overseer['listCollaborators']>(async () => [ALICE]),
  addCollaborator: vi.fn<Overseer['addCollaborator']>(async (id, grant) => person(id, id, grant)),
  listObserverRequirements: vi.fn<Overseer['listObserverRequirements']>(async () => []),
  previewRemoveCollaborator: vi.fn<Overseer['previewRemoveCollaborator']>(async () => []),
  removeCollaborator: vi.fn<Overseer['removeCollaborator']>(async () => []),
})

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('PointerEvent', MouseEvent)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  copyToClipboard.mockClear()
  toastAdd.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const findButton = (label: string) => [...document.body.querySelectorAll('button')].find(button =>
  button.textContent?.trim() === label || button.getAttribute('aria-label') === label)
const click = async (label: string) => {
  const target = findButton(label)
  if (!target) throw new Error(`Missing button: ${label}`)
  await act(async () => { target.click() })
}
const input = () => document.body.querySelector<HTMLInputElement>('input[type="search"]')
// Waits out the directory search's debounce, so a lookup -- or its absence -- has had its chance.
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
const type = async (value: string) => {
  const field = input()!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
const pressEnter = () => act(async () => {
  input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})
const peopleNames = () => [...document.body.querySelectorAll('section[aria-label="People with access"] p')]
  .map(line => line.textContent)

type RenderOptions = {
  api?: ReturnType<typeof makeApi>
  searchEnabled?: boolean
  metadata?: WorkspaceMetadata
  searchUsers?: (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
}

const render = async (kind: 'workspace' | 'gadget', {
  api = makeApi(),
  searchEnabled = false,
  metadata = METADATA,
  searchUsers = async () => [{ id: 'bob', name: 'Bob' }],
}: RenderOptions = {}) => {
  const search = vi.fn<(query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>>(searchUsers)
  // Like the real stub, return a disposable RpcPromise.
  const authenticatedApi = {
    searchUsers: (query: string, excludeIds: string[]) => new RpcPromise(search(query, excludeIds)),
    listGatekeeperVendors: async () => [],
    listAddableGatekeepers: async () => [],
  } as unknown as RpcStub<AuthenticatedApi>
  const currentUser = metadata.owner ? { type: 'user' as const, id: 'member@example.com', name: 'Member' } : OWNER
  const shared = { open: true, onClose: () => {}, overseer: api as unknown as RpcStub<Overseer>, metadata, currentUser, authenticatedApi }
  await act(async () => root.render(
    <ServerConfigContext.Provider value={{ userSearchEnabled: searchEnabled } as ServerConfig}>
      {kind === 'workspace' ? <WorkspaceInviteModal {...shared} /> : <GadgetShareModal {...shared} gadget={GADGET} />}
    </ServerConfigContext.Provider>,
  ))
  return { api, searchUsers: search }
}

describe('workspace invitations', () => {
  it('invites members to the whole workspace', async () => {
    const { api } = await render('workspace')
    expect(document.body.textContent).toContain('Invite to Workspace')
    await type('bob')
    await click('Invite')
    expect(api.addCollaborator).toHaveBeenCalledWith('bob', 'workspace', undefined)
  })

  it('confirms who was added and offers the link to send them', async () => {
    await render('workspace')
    await type('bob')
    await click('Invite')
    const status = document.body.querySelector('[role="status"]')
    expect(status?.textContent).toContain('bob can now access this workspace.')
    expect(status?.textContent).toContain('Send them the link so they can open it.')
    const copy = [...status!.querySelectorAll('button')].find(button => button.textContent === 'Copy link')!
    await act(async () => { copy.click() })
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1`)
    await type('carol')
    expect(document.body.textContent).not.toContain('can now access this workspace')
  })

  it('says when someone is already a member instead of inviting them again', async () => {
    const { api } = await render('workspace')
    await type('ALICE')
    await click('Invite')
    expect(api.addCollaborator).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe('Alice is already a member of this workspace.')
  })

  it('copies the plain workspace URL, which grants nothing by itself', async () => {
    const { api } = await render('workspace')
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1`)
    expect(api.addCollaborator).not.toHaveBeenCalled()
  })

  it('lists workspace members, not people given only gadgets', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, GUS, LEE])
    await render('workspace', { api })
    expect(peopleNames()).toEqual(['Owner (You)', 'Alice'])
  })

  it('leaves gadget recipients findable, since they can still be invited to the workspace', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, GUS])
    const { searchUsers } = await render('workspace', { api, searchEnabled: true })
    await type('bob')
    expect(searchUsers).toHaveBeenCalledWith('bob', ['owner@example.com', 'alice'])
  })

  it('excludes the owner from search when the caller is a member', async () => {
    const { searchUsers } = await render('workspace', { searchEnabled: true, metadata: { ...METADATA, owner: OWNER, role: 'build' } })
    await type('bob')
    expect(searchUsers.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['owner@example.com', 'member@example.com']))
  })

  it('waits for the member list before searching', async () => {
    const api = makeApi()
    let resolve!: (people: CollaboratorInfo[]) => void
    api.listCollaborators.mockReturnValue(new Promise(done => { resolve = done }))
    const { searchUsers } = await render('workspace', { api, searchEnabled: true })
    await type('bob')
    expect(searchUsers).not.toHaveBeenCalled()
    await act(async () => resolve([ALICE]))
    await settle()
    expect(searchUsers).toHaveBeenCalledTimes(1)
  })

  it('invites a typed exact id the directory has not indexed', async () => {
    const { api } = await render('workspace', { searchEnabled: true, searchUsers: async () => [] })
    await type('new@example.com')
    await pressEnter()
    expect(api.addCollaborator).toHaveBeenCalledWith('new@example.com', 'workspace', undefined)
  })

  it('falls back to a direct invite when the directory is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api } = await render('workspace', { searchEnabled: true, searchUsers: async () => { throw new Error('down') } })
    await type('new@example.com')
    await click('Invite')
    expect(api.addCollaborator).toHaveBeenCalledWith('new@example.com', 'workspace', undefined)
  })

  it('reports an unknown account and a refused invite inline', async () => {
    const api = makeApi()
    api.addCollaborator.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Only the workspace owner can add people.'))
    await render('workspace', { api })
    await type('ghost')
    await click('Invite')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('No account found for that username or email.')
    expect(input()?.getAttribute('aria-invalid')).toBe('true')
    await type('bob')
    await click('Invite')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Only the workspace owner can add people.')
  })

  it('reviews and selects indirect invitees in the removal table', async () => {
    const api = makeApi()
    const bob = person('bob', 'Bob', 'workspace', 'alice')
    const carol = person('carol', 'Carol', 'workspace', 'bob')
    api.previewRemoveCollaborator.mockResolvedValue([affected(ALICE), affected(bob), affected(carol)])
    api.listCollaborators.mockResolvedValue([ALICE, bob, carol])
    await render('workspace', { api })
    await click('Access for Alice: Member')
    await click('Remove')
    expect(api.previewRemoveCollaborator).toHaveBeenCalledWith('alice', undefined)
    await click('You can also remove people Alice invited')
    const rows = document.body.querySelectorAll('tbody tr')
    expect(rows[0]?.querySelector('td:last-child')?.textContent).toBe('Alice')
    expect(rows[1]?.querySelector('td:last-child')?.textContent).toBe('Bob')
    const checkboxes = [...document.body.querySelectorAll('tbody [role="checkbox"]')]
    expect(checkboxes.map(checkbox => checkbox.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    const selectAll = document.body.querySelector<HTMLElement>('[role="checkbox"][aria-label="Select all people to remove"]')!
    await act(async () => { selectAll.click() })
    expect(checkboxes.map(checkbox => checkbox.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    expect(findButton('Remove (3)')).toBeDefined()
    await act(async () => { selectAll.click() })
    const bobCheckbox = document.body.querySelector<HTMLElement>('[role="checkbox"][aria-label="Remove Bob"]')!
    await act(async () => { bobCheckbox.closest('tr')!.click() })
    expect(bobCheckbox.getAttribute('aria-checked')).toBe('true')
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
    await click('Remove (2)')
    expect(api.removeCollaborator).toHaveBeenCalledWith('alice', ['carol'], undefined)
  })

  it('keeps indirect invitees by default without opening the review', async () => {
    const api = makeApi()
    api.previewRemoveCollaborator.mockResolvedValue([
      affected(ALICE), affected(person('bob', 'Bob', 'workspace', 'alice')), affected(person('carol', 'Carol', 'workspace', 'bob')),
    ])
    await render('workspace', { api })
    await click('Remove')
    await click('Remove')
    expect(api.removeCollaborator).toHaveBeenCalledWith('alice', ['bob', 'carol'], undefined)
  })

  it('lets members remove only the people they added', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, person('bob', 'Bob', 'workspace', 'member@example.com')])
    await render('workspace', { api, metadata: { ...METADATA, owner: OWNER, role: 'build' } })
    expect(findButton('Access for Alice: Member')).toBeUndefined()
    expect(findButton('Access for Bob: Member')).toBeDefined()
  })

  it('lists the connections new members must verify', async () => {
    const api = makeApi()
    api.listObserverRequirements.mockResolvedValue([REQUIREMENT])
    await render('workspace', { api })
    expect(api.listObserverRequirements).toHaveBeenCalledWith('workspace')
    await click('Protected resources')
    expect(document.body.querySelector('h2')?.textContent).toBe('Protected resources')
    expect(document.body.textContent).toContain('Q3 planning')
    await click('Back to invitations')
    expect(document.body.querySelector('h2')?.textContent).toBe('Invite to Workspace')
  })

  it('hides protected resources when there is nothing to verify', async () => {
    await render('workspace')
    expect(findButton('Protected resources')).toBeUndefined()
  })

  it('explains sensitive data without restricting invites', async () => {
    await render('workspace', { metadata: { ...METADATA, containsRestrictedData: true } })
    expect(document.body.textContent).toContain('This workspace has read sensitive data')
    expect(input()).not.toBeNull()
  })

  it('leaves only the owner able to invite once the workspace is owner-invites-only', async () => {
    const metadata = { ...METADATA, containsRestrictedData: true, ownerInvitesOnly: true }
    await render('workspace', { metadata })
    expect(document.body.textContent).toContain('Only the owner can add people')
    expect(input()).not.toBeNull()
    await render('workspace', { metadata: { ...metadata, owner: OWNER, role: 'build' } })
    expect(document.body.textContent).toContain('Only the owner can add people')
    expect(input()).toBeNull()
  })
})

describe('gadget sharing', () => {
  it('shares only this gadget and copies a link that opens on it', async () => {
    const { api } = await render('gadget')
    expect(document.body.textContent).toContain('My Application')
    expect(document.body.textContent).toContain('People in this workspaceCan edit')
    expect(document.body.textContent).not.toContain('Anyone in Organization')
    await type('bob')
    await click('Share')
    expect(api.addCollaborator).toHaveBeenCalledWith('bob', { gadgetId: 0 }, undefined)
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1?w=0`)
  })

  it('confirms the share and offers a link that opens on the gadget', async () => {
    await render('gadget')
    await type('bob')
    await click('Share')
    const status = document.body.querySelector('[role="status"]')
    expect(status?.textContent).toContain('bob can now view “My Application”.')
    const copy = [...status!.querySelectorAll('button')].find(button => button.textContent === 'Copy link')!
    await act(async () => { copy.click() })
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1?w=0`)
  })

  it.each([
    ['a workspace member', 'alice', 'Alice is a member of this workspace, so they can already edit this gadget.'],
    ['someone it is already shared with', 'gus', 'This gadget is already shared with Gus.'],
    ['someone given every gadget', 'lee', 'Lee can already view every gadget in this workspace.'],
    ['the owner', 'owner@example.com', 'Owner owns this workspace and can already edit this gadget.'],
  ])('says it is already accessible instead of sharing with %s', async (_, id, message) => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, GUS, LEE])
    await render('gadget', { api })
    await type(id)
    await click('Share')
    expect(api.addCollaborator).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe(message)
  })

  it('reports a grant that changed nothing when the member list was stale', async () => {
    const api = makeApi()
    api.addCollaborator.mockResolvedValue(person('bob', 'Bob'))
    await render('gadget', { api })
    await type('bob')
    await click('Share')
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe('Bob is a member of this workspace, so they can already edit this gadget.')
  })

  it('lists only the people given this gadget on its own', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, GUS, HAL, LEE])
    await render('gadget', { api })
    expect(peopleNames()).toEqual(['Owner (You)', 'Gus'])
  })

  it('excludes members and everyone already holding the gadget from search', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([ALICE, GUS, HAL])
    const { searchUsers } = await render('gadget', { api, searchEnabled: true })
    await type('bob')
    expect(searchUsers).toHaveBeenCalledWith('bob', ['owner@example.com', 'alice', 'gus'])
  })

  it('removes only this gadget from a recipient, and returns on Cancel', async () => {
    const api = makeApi()
    api.listCollaborators.mockResolvedValue([GUS])
    api.previewRemoveCollaborator.mockResolvedValue([{ ...GUS, oldAccess: GUS.access, newAccess: { role: 'use', gadgetIds: [1] } }])
    await render('gadget', { api })
    await click('Remove')
    expect(api.previewRemoveCollaborator).toHaveBeenCalledWith('gus', 0)
    expect(document.body.querySelectorAll('dialog')).toHaveLength(1)
    expect(document.body.querySelector('h2')?.textContent).toBe('Remove Gus?')
    expect(document.body.textContent).toContain('Gus will lose access to this gadget.')
    await click('Cancel')
    expect(document.body.querySelector('h2')?.textContent).toContain('Share')
    expect(api.removeCollaborator).not.toHaveBeenCalled()
    await click('Remove')
    await click('Remove')
    expect(api.removeCollaborator).toHaveBeenCalledWith('gus', [], 0)
  })

  it('lists the connections this gadget’s viewers must verify', async () => {
    const api = makeApi()
    api.listObserverRequirements.mockResolvedValue([REQUIREMENT])
    await render('gadget', { api })
    expect(api.listObserverRequirements).toHaveBeenCalledWith({ gadgetId: 0 })
    expect(findButton('Protected resources')?.textContent).toContain('(1)')
  })

  it('hides sharing from members once the workspace is owner-invites-only', async () => {
    await render('gadget', { metadata: { ...METADATA, ownerInvitesOnly: true, owner: OWNER, role: 'build' } })
    expect(document.body.textContent).toContain('Only the owner can add people')
    expect(input()).toBeNull()
  })
})

it.each(['workspace', 'gadget'] as const)('keeps %s search open without refreshing membership or restarting the directory request', async kind => {
  const { api, searchUsers } = await render(kind, { searchEnabled: true })
  await type('bob')
  expect(api.listCollaborators).toHaveBeenCalledTimes(1)
  expect(searchUsers).toHaveBeenCalledTimes(1)
  expect(document.body.querySelector('[role="combobox"]')?.getAttribute('aria-expanded')).toBe('true')
  expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Bob')
})
