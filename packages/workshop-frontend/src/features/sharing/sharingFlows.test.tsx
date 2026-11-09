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
vi.mock('../../GadgetUI', () => ({ default: () => <div data-testid="view-preview" /> }))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const { createContext, useContext } = await import('react')
  const Radio = createContext<(value: string) => void>(() => {})
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
      RadioGroup: ({ children, onValueChange }: { children: ReactNode; onValueChange: (value: string) => void }) =>
        <Radio.Provider value={onValueChange}>{children}</Radio.Provider>,
      RadioItem: ({ children, value }: { children: ReactNode; value: string }) => {
        const choose = useContext(Radio)
        return <button role="menuitemradio" aria-checked={false} onClick={() => choose(value)}>{children}</button>
      },
      RadioItemIndicator: () => null,
    }),
  }
})

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'owner@example.com', name: 'Owner' }
const METADATA = { id: 'workspace-1', title: 'Workspace', kind: 'workspace' } as WorkspaceMetadata
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
  listShareLinks: vi.fn<Overseer['listShareLinks']>(async () => []),
  createShareLink: vi.fn<Overseer['createShareLink']>(async () => ({ key: 'k1', linkId: 'link-1' })),
  newShareLinkKey: vi.fn<Overseer['newShareLinkKey']>(async () => ({ key: 'k2' })),
  previewRevokeShareLink: vi.fn<Overseer['previewRevokeShareLink']>(async () => []),
  revokeShareLink: vi.fn<Overseer['revokeShareLink']>(async () => []),
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
const GROUP_ROW = /^(Members of |Anyone in |People in this chat)/
const peopleNames = () => [...document.body.querySelectorAll('section[aria-label="People with access"] p')]
  .map(line => line.textContent).filter(name => !GROUP_ROW.test(name ?? ''))

type RenderOptions = {
  api?: ReturnType<typeof makeApi>
  searchEnabled?: boolean
  metadata?: WorkspaceMetadata
  searchUsers?: (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
  gadget?: Parameters<typeof GadgetShareModal>[0]['gadget']
}

const render = async (kind: 'workspace' | 'gadget', {
  api = makeApi(),
  searchEnabled = false,
  metadata = METADATA,
  searchUsers = async () => [{ id: 'bob', name: 'Bob' }],
  gadget = GADGET,
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
    <ServerConfigContext.Provider value={{ userSearchEnabled: searchEnabled, siteName: 'Cloudflare' } as ServerConfig}>
      {kind === 'workspace' ? <WorkspaceInviteModal {...shared} /> : <GadgetShareModal {...shared} gadget={gadget} />}
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
    expect(status?.textContent).toContain('bob is now a member of Workspace.')
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
    await click('Remove access')
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
    await click('Remove access')
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
    expect(document.body.textContent).toContain('Members of WorkspaceCan edit')
    await type('bob')
    await click('Share')
    expect(api.addCollaborator).toHaveBeenCalledWith('bob', { gadgetId: 0 }, undefined)
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0`)
  })

  it('confirms the share and offers a link that opens on the gadget', async () => {
    await render('gadget')
    await type('bob')
    await click('Share')
    const status = document.body.querySelector('[role="status"]')
    expect(status?.textContent).toContain('bob can now use “My Application”.')
    const copy = [...status!.querySelectorAll('button')].find(button => button.textContent === 'Copy link')!
    await act(async () => { copy.click() })
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0`)
  })

  it.each([
    ['a workspace member', 'alice', 'Alice is a member of this workspace, so they can already edit this gadget.'],
    ['someone it is already shared with', 'gus', 'This gadget is already shared with Gus.'],
    ['someone given every gadget', 'lee', 'Lee can already use every gadget in this workspace.'],
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
    await click('Remove access')
    expect(api.previewRemoveCollaborator).toHaveBeenCalledWith('gus', 0)
    expect(document.body.querySelectorAll('dialog')).toHaveLength(1)
    expect(document.body.querySelector('h2')?.textContent).toBe('Remove Gus?')
    expect(document.body.textContent).toContain('Gus will lose access to this gadget.')
    await click('Cancel')
    expect(document.body.querySelector('h2')?.textContent).toContain('Share')
    expect(api.removeCollaborator).not.toHaveBeenCalled()
    await click('Remove access')
    await click('Remove')
    expect(api.removeCollaborator).toHaveBeenCalledWith('gus', [], 0)
  })

  it('lists the connections this gadget’s viewers must verify', async () => {
    const api = makeApi()
    api.listObserverRequirements.mockResolvedValue([REQUIREMENT])
    await render('gadget', { api })
    expect(api.listObserverRequirements).toHaveBeenCalledWith({ gadgetId: 0 })
    expect(findButton('Protected resources')?.textContent).toContain('1')
  })

  it('copies a link only listed people can open while Anyone in the deployment has no access', async () => {
    await render('gadget')
    expect(findButton('Access for Anyone in Cloudflare: No access')).toBeDefined()
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0`)
  })

  it('turns on the gadget’s one link, and copies it with its key', async () => {
    const { api } = await render('gadget')
    await click('Can useAnyone with the link can open it')
    expect(api.createShareLink).toHaveBeenCalledWith({ gadgetId: 0 })
    expect(toastAdd).toHaveBeenCalledWith({ title: 'Anyone in Cloudflare with the link can use it' })
    expect(findButton('Access for Anyone in Cloudflare: Can use')).toBeDefined()
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0#share=k1`)
  })

  it('turns every link to the gadget off, keeping the people who already opened it', async () => {
    const api = makeApi()
    const link = (linkId: string, gadgetId: number) =>
      ({ linkId, role: 'use' as const, gadgetId, created: CREATED, createdBy: OWNER })
    api.listShareLinks.mockResolvedValue([link('old', 0), link('newer', 0), link('other', 1)])
    api.previewRevokeShareLink.mockImplementation(async linkId => linkId === 'old' ? [affected(GUS)] : [])
    await render('gadget', { api })
    expect(api.newShareLinkKey).toHaveBeenCalledWith('old')
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0#share=k2`)

    const loads = api.listCollaborators.mock.calls.length
    await click('No accessOnly people you add can open it')
    expect(api.revokeShareLink.mock.calls).toEqual([['old', ['gus']], ['newer', []]])
    expect(api.listCollaborators.mock.calls.length).toBeGreaterThan(loads)
    expect(findButton('Access for Anyone in Cloudflare: No access')).toBeDefined()
  })

  it('locks the link off once the workspace is owner-invites-only, since nobody could redeem it', async () => {
    const api = makeApi()
    api.listShareLinks.mockResolvedValue([{ linkId: 'l', role: 'use', gadgetId: 0, created: CREATED, createdBy: OWNER }])
    await render('gadget', { api, metadata: { ...METADATA, ownerInvitesOnly: true } })
    expect(document.body.textContent).toContain('Anyone in CloudflareNo access')
    expect(findButton('Access for Anyone in Cloudflare: No access')).toBeUndefined()
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1/app/0`)
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

describe('gadget sharing with shared views', () => {
  const SHARED = { ...METADATA, sharedViewsAvailable: true } as WorkspaceMetadata
  const TAKEN = new Date()
  // A view of the gadget, its tree, and who has the workspace open right now.
  const viewApi = (present: string[] = []) => {
    const api = makeApi()
    api.listObserverRequirements.mockResolvedValue([REQUIREMENT])
    const disposable = <T,>(value: T) => Object.assign(Promise.resolve(value), { [Symbol.dispose]() {} })
    return Object.assign(api, {
      listTree: vi.fn<() => Promise<{ name: string }[]>>(async () => [{ name: 'client.js' }, { name: 'server.js' }]),
      getGadget: vi.fn<() => object>(() => Object.assign({
        // The view client the preview runs the gadget's UI against.
        openView: () => disposable({ getAccessMode: async () => 'view', [Symbol.dispose]() {} }),
      }, { [Symbol.dispose]() {} })),
      subscribeToPresence: vi.fn<(subscriber: { init: (list: unknown[]) => void }) => Promise<void>>((subscriber) => {
        void subscriber.init(present.map(id => ({ key: id, user: { type: 'user', id, name: id }, role: 'use' })))
        return disposable(undefined)
      }),
    })
  }

  it('says people without access will see the owner’s view, then that they do once someone has it', async () => {
    const api = viewApi()
    api.addCollaborator.mockImplementation(async (id, grant) => person(id, 'Bob Ortiz', grant))
    await render('gadget', { api, metadata: SHARED })
    expect(findButton('People without access will see a snapshot')).toBeDefined()
    expect(findButton('Protected resources')).toBeUndefined()
    await type('bob')
    await click('Share')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Shared with Bob. Bob sees what you see.')
  })

  it('uses the present tense once the gadget is shared', async () => {
    const api = viewApi()
    api.listCollaborators.mockResolvedValue([GUS])
    await render('gadget', { api, metadata: SHARED })
    expect(findButton('People without access see a snapshot')).toBeDefined()
  })

  it('shows what people see: the owner’s view and the sources that let someone explore it', async () => {
    await render('gadget', { api: viewApi(), metadata: SHARED, gadget: { ...GADGET, commitId: 'c1', viewTakenAt: TAKEN } })
    await click('People without access will see a snapshot')
    expect(document.body.querySelector('h2')?.textContent).toBe('What people see')
    const text = document.body.textContent
    expect(text).toMatch(/Snapshot · Updated today at \d/)
    expect(text).toContain('Everyone you share with')
    expect(text).toContain('Sees an up-to-date snapshot of it, with your data.')
    expect(text).toContain('People with access to these')
    expect(text).toContain('Can use it live, alongside you.')
    expect(text).toContain('They sign in only to confirm access. It still runs on your connections.')
    expect(text).toContain('Q3 planning')
    expect(text).not.toContain('Couldn’t update it')
    await click('Back to sharing')
    expect(document.body.querySelector('h2')?.textContent).toContain('Share')
  })

  it('tells only the owner when the view could not be replaced', async () => {
    const failed = new Date(TAKEN.getTime() + 60_000)
    await render('gadget', {
      api: viewApi(), metadata: SHARED, gadget: { ...GADGET, commitId: 'c1', viewTakenAt: TAKEN, viewUpdateFailedAt: failed },
    })
    await click('People without access will see a snapshot')
    expect(document.body.textContent).toMatch(/Couldn’t update it\. People see the one from today at \d/)
  })

  it('previews the view before anyone has the gadget, which is what takes the first one', async () => {
    const api = viewApi()
    await render('gadget', { api, metadata: SHARED, gadget: { ...GADGET, commitId: 'c1' } })
    await click('People without access will see a snapshot')
    expect(api.getGadget).toHaveBeenCalledWith(0)
    expect(document.body.textContent).not.toContain('Taken when')
  })

  it('says plainly when the gadget has no screen to take a view of', async () => {
    const api = viewApi()
    api.listTree.mockResolvedValue([{ name: 'server.js' }])
    await render('gadget', { api, metadata: SHARED, gadget: { ...GADGET, commitId: 'c1' } })
    await click('People without access will see a snapshot')
    expect(document.body.textContent).toContain('This gadget has no screen, so only people with access to these can open it.')
    expect(document.body.textContent).toContain('Can open it and use it with you.')
    expect(document.body.textContent).not.toContain('Everyone you share with')
  })

  it('says what removal does to the person, and that someone on live data is disconnected', async () => {
    const preview = [{ ...GUS, oldAccess: GUS.access, newAccess: null }]
    const idle = viewApi()
    idle.listCollaborators.mockResolvedValue([GUS])
    idle.previewRemoveCollaborator.mockResolvedValue(preview)
    await render('gadget', { api: idle, metadata: SHARED })
    await click('Remove access')
    expect(document.body.textContent).toContain('Gus will no longer see this gadget.')

    const liveGus = { ...GUS, lastOpened: { 0: { at: TAKEN, mode: 'live' as const } } }
    const live = viewApi(['gus'])
    live.listCollaborators.mockResolvedValue([liveGus])
    live.previewRemoveCollaborator.mockResolvedValue([{ ...liveGus, oldAccess: GUS.access, newAccess: null }])
    await act(async () => root.unmount())
    root = createRoot(host)
    await render('gadget', { api: live, metadata: SHARED })
    await click('Remove access')
    expect(document.body.textContent).toContain('Gus will no longer see this gadget and will be disconnected now.')
  })

  it('drops the sensitive-data warning, which shared views make untrue, but keeps the owner-only rule', async () => {
    await render('gadget', { api: viewApi(), metadata: { ...SHARED, containsRestrictedData: true } })
    expect(document.body.textContent).not.toContain('This workspace has read sensitive data')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render('gadget', { api: viewApi(), metadata: { ...SHARED, ownerInvitesOnly: true, owner: OWNER, role: 'build' } })
    expect(document.body.textContent).toContain('Only the owner can add people')
  })

  it('keeps protected resources where the deployment serves no shared views', async () => {
    await render('gadget', { api: viewApi(), metadata: { ...METADATA, containsRestrictedData: true } })
    expect(findButton('Protected resources')?.textContent).toContain('1')
    expect(document.body.textContent).toContain('This workspace has read sensitive data')
  })
})
