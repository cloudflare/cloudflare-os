// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcPromise, type RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorAccess,
  CollaboratorGrant,
  CollaboratorInfo,
  WorkspaceMetadata,
  ObserverBindingNeed,
  Overseer,
  PermissionEdge,
  ServerConfig,
  ShareLinkInfo,
  UserDirectoryRecord,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from './ServerConfigContext'

const toastAdd = vi.hoisted(() => vi.fn<(toast: unknown) => void>())

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const previousScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn<Element['scrollIntoView']>(),
})
afterAll(() => {
  if (previousScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', previousScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
})

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  return {
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    useKumoToastManager: () => ({ add: toastAdd }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const copyToClipboard = vi.fn<(text: string) => Promise<boolean>>(async () => true)
vi.mock('./clipboard', () => ({ copyToClipboard: (text: string) => copyToClipboard(text) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

import ShareModal, { type ShareTarget } from './ShareModal'

const METADATA = { id: 'trip-planner', title: 'Trip planner' } as WorkspaceMetadata
const WORKSPACE_URL = `${window.location.origin}/workspace/trip-planner`
// Gadget id 0 catches code that tests the id for truthiness instead of presence.
const GADGET_TARGET: ShareTarget = { kind: 'gadget', gadgetId: 0, title: 'Itinerary' }
const GADGET_URL = `${WORKSPACE_URL}?w=0`

const CURRENT_USER: AiChatAuthorInfo = { type: 'user', id: 'dan@cloudflare.com', name: 'Dan' }

const DOC_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 7,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

const CRM_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 8,
  vendorId: 'salesforce',
  resourceTitle: 'Pipeline dashboard',
}

const SHARE_LINK: ShareLinkInfo = {
  linkId: 'link-1',
  note: 'Team link',
  created: new Date('2026-08-01T00:00:00Z'),
  createdBy: CURRENT_USER,
  role: 'build',
}

type OverseerOverrides = {
  requirements?: ObserverBindingNeed[]
  listObserverRequirements?: Overseer['listObserverRequirements']
  collaborators?: CollaboratorInfo[]
  listCollaborators?: () => Promise<CollaboratorInfo[]>
  shareLinks?: ShareLinkInfo[]
  updateShareLink?: (linkId: string, note?: string) => Promise<void>
  addCollaborator?: Overseer['addCollaborator']
  createShareLink?: Overseer['createShareLink']
  newShareLinkKey?: Overseer['newShareLinkKey']
  previewRemoveCollaborator?: Overseer['previewRemoveCollaborator']
  removeCollaborator?: Overseer['removeCollaborator']
}

function fakeOverseer(overrides: OverseerOverrides = {}): RpcStub<Overseer> {
  return {
    listCollaborators: overrides.listCollaborators ?? (async () => overrides.collaborators ?? []),
    listShareLinks: async () => overrides.shareLinks ?? [],
    listObserverRequirements:
      overrides.listObserverRequirements ?? (async () => overrides.requirements ?? []),
    addCollaborator: overrides.addCollaborator ??
      (async (userId: string, grant: CollaboratorGrant) => profileFor(userId, grant, 'Ada')),
    createShareLink: overrides.createShareLink ?? (async () => ({ key: 'secret', linkId: 'link-1' })),
    newShareLinkKey: overrides.newShareLinkKey ?? (async () => ({ key: 'fresh' })),
    updateShareLink: overrides.updateShareLink ?? (async () => {}),
    previewRemoveCollaborator: overrides.previewRemoveCollaborator ?? (async () => []),
    removeCollaborator: overrides.removeCollaborator ?? (async () => []),
  } as unknown as RpcStub<Overseer>
}

type AuthenticatedApiOverrides = {
  searchUsers?: (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
}

function fakeAuthenticatedApi({
  searchUsers = async (query) => query ? [{
    id: `${query}@example.com`,
    name: query === 'ada' ? 'Ada' : query,
  }] : [],
}: AuthenticatedApiOverrides = {}): RpcStub<AuthenticatedApi> {
  return {
    // Like the real stub, return a disposable RpcPromise.
    searchUsers: (query: string, excludeIds: string[]) => new RpcPromise(searchUsers(query, excludeIds)),
  } as unknown as RpcStub<AuthenticatedApi>
}

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button labelled “${label}”`)
  return found
}

// The section a heading labels, such as the people list or the share links.
function sectionFor(rendered: HTMLElement, headingId: string): HTMLElement {
  const section = rendered.querySelector(`#${headingId}`)?.closest('section')
  if (!section) throw new Error(`No section with heading “${headingId}”`)
  return section as HTMLElement
}

// A collaborator's row within a section, found by the name it shows.
function personRow(section: HTMLElement, name: string): HTMLElement | null {
  const nameLine = [...section.querySelectorAll('p')].find(line => line.textContent === name)
  return nameLine?.closest<HTMLElement>('.group') ?? null
}

// Types into the people field and waits out the search debounce (200ms), so a directory lookup
// -- or the absence of one -- has had its chance to happen.
async function typeInto(input: HTMLInputElement, query: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  vi.useFakeTimers()
  try {
    await act(async () => {
      setValue.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(225))
  } finally {
    vi.useRealTimers()
  }
}

async function typeDirectorySearch(rendered: HTMLElement, query: string) {
  await typeInto(rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!, query)
}

async function invite(rendered: HTMLElement, username: string) {
  await typeDirectorySearch(rendered, username)
  const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')
  if (!option) throw new Error('Expected a directory search result.')
  await click(option)
  await click(button(rendered, 'Invite'))
}

async function createLink(rendered: HTMLElement) {
  await click(button(rendered, 'Create a share link'))
  await click(button(rendered, 'Create link'))
}

function peopleInput(rendered: HTMLElement): HTMLInputElement {
  return rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
}

function pressKey(input: HTMLInputElement, key: string) {
  return act(async () => input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  ))
}

// The names staged in the composer, read from the chips' remove buttons. The people list's own
// remove buttons live inside a <section>, so they are left out.
function stagedNames(rendered: HTMLElement): string[] {
  return [...rendered.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]')]
    .filter(remove => remove.closest('section') === null)
    .map(remove => remove.getAttribute('aria-label')!.slice('Remove '.length))
}

function accessFor(grant: CollaboratorGrant): CollaboratorAccess {
  return grant === 'build' ? { role: 'build' } : { role: 'use', gadgetIds: [grant.gadgetId] }
}

function profileFor(userId: string, grant: CollaboratorGrant, name: string): CollaboratorInfo {
  return { profile: { type: 'user', id: userId, name }, access: accessFor(grant), addedBy: [] }
}

function collaborator(
  userId: string,
  name: string,
  access: CollaboratorAccess,
  addedBy: PermissionEdge[] = [],
): CollaboratorInfo {
  return { profile: { type: 'user', id: userId, name }, access, addedBy }
}

const CREATED = new Date('2026-08-01T00:00:00Z')
const BUILD_MEMBER = collaborator('bea@example.com', 'Bea', { role: 'build' }, [
  { type: 'user', sharer: CURRENT_USER.id, created: CREATED, role: 'build' },
])
const LEGACY_COLLABORATOR = collaborator('lee@example.com', 'Lee', { role: 'use', gadgetIds: 'all' }, [
  { type: 'user', sharer: CURRENT_USER.id, created: CREATED, role: 'use' },
])
// Holds the dialog's gadget (0) directly and another gadget (1) through a link.
const GADGET_RECIPIENT = collaborator('gus@example.com', 'Gus', { role: 'use', gadgetIds: [0, 1] }, [
  { type: 'user', sharer: CURRENT_USER.id, created: CREATED, role: 'use', gadgetId: 0 },
  { type: 'shareKey', keyId: 'link-budget', created: CREATED, role: 'use', gadgetId: 1 },
])
const OTHER_GADGET_RECIPIENT = collaborator('hal@example.com', 'Hal', { role: 'use', gadgetIds: [1] }, [
  { type: 'user', sharer: CURRENT_USER.id, created: CREATED, role: 'use', gadgetId: 1 },
])

// jsdom has no ResizeObserver; the stub records each observer so a test can fire its callback
// and check it was disconnected.
type RecordedResizeObserver = { targets: Element[]; callback: () => void; disconnect: ReturnType<typeof vi.fn<() => void>> }
const resizeObservers: RecordedResizeObserver[] = []

describe('ShareModal', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    copyToClipboard.mockClear()
    toastAdd.mockClear()
    resizeObservers.length = 0
    vi.stubGlobal('ResizeObserver', class {
      readonly #record: RecordedResizeObserver
      constructor(callback: () => void) {
        this.#record = { targets: [], callback, disconnect: vi.fn<() => void>() }
        resizeObservers.push(this.#record)
      }
      observe(target: Element) { this.#record.targets.push(target) }
      disconnect() { this.#record.disconnect() }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  // The last rendered tree, parameterised on `open` so a test can close and reopen the dialog the
  // way its parent would (the component stays mounted either way), and on the metadata so a test
  // can deliver a live update.
  let renderTree: (open: boolean, metadata?: WorkspaceMetadata) => ReactNode

  async function render(
    overseer: RpcStub<Overseer>,
    authenticatedApi = fakeAuthenticatedApi(),
    metadata: WorkspaceMetadata = METADATA,
    { userSearchEnabled = true, target = { kind: 'workspace' } as ShareTarget } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const serverConfig = { userSearchEnabled } as ServerConfig
    renderTree = (open, currentMetadata = metadata) => (
      <ServerConfigContext.Provider value={serverConfig}>
        <ShareModal
          open={open}
          onClose={() => {}}
          overseer={overseer}
          metadata={currentMetadata}
          target={target}
          currentUser={CURRENT_USER}
          authenticatedApi={authenticatedApi}
        />
      </ServerConfigContext.Provider>
    )
    await act(async () => { root!.render(renderTree(true)) })
    // Let the load effects settle.
    await act(async () => { await Promise.resolve() })
    return document.body
  }

  async function setOpen(open: boolean) {
    await act(async () => { root!.render(renderTree(open)) })
    await act(async () => { await Promise.resolve() })
  }

  function renderGadget(overseer: RpcStub<Overseer>, authenticatedApi = fakeAuthenticatedApi()) {
    return render(overseer, authenticatedApi, METADATA, { target: GADGET_TARGET })
  }

  async function updateMetadata(metadata: WorkspaceMetadata) {
    await act(async () => { root!.render(renderTree(true, metadata)) })
  }

  it('reveals the workspace link to send after a direct invite', async () => {
    const rendered = await render(fakeOverseer())
    expect(rendered.textContent).not.toContain(WORKSPACE_URL)

    await invite(rendered, 'ada')

    expect(rendered.textContent).toContain('Added Ada')
    expect(rendered.textContent).toContain(WORKSPACE_URL)
  })

  it('keeps Invite disabled until a recipient can be submitted', async () => {
    const rendered = await render(fakeOverseer())
    expect(button(rendered, 'Invite').disabled).toBe(true)

    await invite(rendered, 'ada')
    expect(button(rendered, 'Invite').disabled).toBe(true)
  })

  it('copies the plain workspace link, never a share-link secret', async () => {
    const rendered = await render(fakeOverseer())
    await invite(rendered, 'ada')

    await click(button(rendered, 'Copy link'))

    expect(copyToClipboard).toHaveBeenCalledWith(WORKSPACE_URL)
    expect(rendered.textContent).toContain('Link copied')
  })

  it('excludes existing people and submits the selected directory result id', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Ada Lovelace'))
    const existingCollaborator: CollaboratorInfo = {
      profile: { type: 'user', id: 'maximo@cloudflare.com', name: 'maximo' },
      access: { role: 'build' },
      addedBy: [],
    }
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [
      { id: 'ada@cloudflare.com', name: 'Ada Lovelace' },
    ])
    const rendered = await render(
      fakeOverseer({ addCollaborator, collaborators: [existingCollaborator] }),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'love')
    expect(searchUsers).toHaveBeenCalledWith('love', [
      'dan@cloudflare.com',
      'maximo@cloudflare.com',
    ])
    expect(rendered.textContent).toContain('Ada Lovelace')
    expect(rendered.textContent).toContain('ada@cloudflare.com')

    const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')!
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => option.dispatchEvent(mouseDown))
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Picking a result stages it as a chip and clears the field for the next name.
    expect(stagedNames(rendered)).toEqual(['Ada Lovelace (ada@cloudflare.com)'])
    expect(peopleInput(rendered).value).toBe('')
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@cloudflare.com', 'build', undefined)
    expect(stagedNames(rendered)).toEqual([])
  })

  it('submits the highlighted result from the primary Invite action', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async () => [{ id: 'ada@cloudflare.com', name: 'Ada Lovelace' }],
      }),
    )

    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.querySelector('[role="option"][aria-selected="true"]')?.textContent)
      .toContain('Ada Lovelace')
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@cloudflare.com', 'build', undefined)
  })

  it('excludes the workspace owner when the caller is a collaborator', async () => {
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [])
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
      { ...METADATA, owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' } } as WorkspaceMetadata,
    )

    await typeDirectorySearch(rendered, 'own')
    expect(searchUsers).toHaveBeenCalledWith('own', ['dan@cloudflare.com', 'owner@cloudflare.com'])
  })

  it('waits for the membership list before searching', async () => {
    const membership = deferred<CollaboratorInfo[]>()
    const existingCollaborator: CollaboratorInfo = {
      profile: { type: 'user', id: 'maximo@cloudflare.com', name: 'Maximo' },
      access: { role: 'build' },
      addedBy: [],
    }
    const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(async () => [])
    const rendered = await render(
      fakeOverseer({ listCollaborators: () => membership.promise }),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'ada')
    expect(searchUsers).not.toHaveBeenCalled()
    expect(button(rendered, 'Invite').disabled).toBe(true)

    vi.useFakeTimers()
    try {
      await act(async () => {
        membership.resolve([existingCollaborator])
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => vi.advanceTimersByTimeAsync(225))
    } finally {
      vi.useRealTimers()
    }

    expect(searchUsers).toHaveBeenCalledWith('ada', [
      'dan@cloudflare.com',
      'maximo@cloudflare.com',
    ])
  })

  it('submits a typed exact id when the directory has not indexed the account', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Dormant User'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('No users found.')
    const input = peopleInput(rendered)
    await pressKey(input, 'Enter')
    expect(addCollaborator).not.toHaveBeenCalled()

    // Enter on the now-empty field sends everyone staged.
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'build', undefined)
  })

  it('stages a typed id as a chip and clears the field', async () => {
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    await pressKey(peopleInput(rendered), 'Enter')

    expect(stagedNames(rendered)).toEqual(['dormant@example.com'])
    expect(peopleInput(rendered).value).toBe('')
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
  })

  it('never queries the directory and invites by exact id when user search is off', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Grace Hopper'))
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [
      { id: 'grace@example.com', name: 'Grace Hopper' },
    ])
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers }),
      METADATA,
      { userSearchEnabled: false },
    )

    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')!
    expect(input.getAttribute('role')).toBeNull()
    expect(button(rendered, 'Invite').disabled).toBe(true)

    await typeInto(input, 'grace@example.com')

    expect(searchUsers).not.toHaveBeenCalled()
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(button(rendered, 'Invite').disabled).toBe(false)
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'build', undefined)
    expect(rendered.textContent).toContain('Added Grace Hopper')
  })

  it('tells apart two staged accounts with one display name', async () => {
    const rendered = await render(fakeOverseer(), fakeAuthenticatedApi({
      searchUsers: async (_query, excludeIds) => [
        { id: 'alex.smith@example.com', name: 'Alex Smith' },
        { id: 'alex.smith2@example.com', name: 'Alex Smith' },
      ].filter(user => !excludeIds.includes(user.id)),
    }))

    await typeDirectorySearch(rendered, 'alex')
    await click(rendered.querySelector<HTMLButtonElement>('[role="option"]')!)
    await typeDirectorySearch(rendered, 'alex')
    await click(rendered.querySelector<HTMLButtonElement>('[role="option"]')!)

    // The chips carry the id as well as the name, so the two are not interchangeable.
    expect(stagedNames(rendered)).toEqual([
      'Alex Smith (alex.smith@example.com)',
      'Alex Smith (alex.smith2@example.com)',
    ])
    expect(rendered.textContent).toContain('alex.smith@example.com')
    expect(rendered.textContent).toContain('alex.smith2@example.com')

    await click(button(rendered, 'Remove Alex Smith (alex.smith2@example.com)'))
    expect(stagedNames(rendered)).toEqual(['Alex Smith (alex.smith@example.com)'])
  })

  it('does not submit a raw query while search is pending', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => pending.promise }),
    )

    await typeDirectorySearch(rendered, 'alex')
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    expect(button(rendered, 'Invite').disabled).toBe(true)
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(addCollaborator).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve([{ id: 'alex.smith@example.com', name: 'Alex Smith' }])
      await Promise.resolve()
    })
    // Enter stages the highlighted match rather than submitting the raw text.
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(stagedNames(rendered)).toEqual(['Alex Smith (alex.smith@example.com)'])
    expect(input.value).toBe('')
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('keeps Invite disabled while a typed name is still searching, even with chips staged', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, grant) => profileFor(userId, grant, userId))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async query => query === 'grace' ? pending.promise : [],
      }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])

    // A click must not send the chips and silently leave the typed name behind.
    await typeDirectorySearch(rendered, 'grace')
    expect(button(rendered, 'Invite').disabled).toBe(true)
    await click(button(rendered, 'Invite'))
    expect(addCollaborator).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve([])
      await Promise.resolve()
    })
    const invite = button(rendered, 'Invite 2 people')
    expect(invite.disabled).toBe(false)
    await click(invite)
    expect(addCollaborator.mock.calls.map(([userId]) => userId)).toEqual(['ada@example.com', 'grace'])
  })

  it('still invites the typed canonical id when unrelated users match it', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Alex'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )

    // The directory is backfilled lazily, so "alex" may be a real account it has not indexed yet.
    await typeDirectorySearch(rendered, 'alex')
    expect(rendered.textContent).toContain('Alexander')
    const exactOption = [...rendered.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(option => option.textContent?.includes('Add “alex” exactly'))
    expect(exactOption).toBeDefined()
    await click(exactOption!)
    expect(stagedNames(rendered)).toEqual(['alex'])
    await click(button(rendered, 'Invite'))
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'build', undefined)
  })

  it('falls back to a direct invite when the directory lookup fails', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Dormant User'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => { throw new Error('offline') } }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('User search is temporarily unavailable.')
    expect(button(rendered, 'Invite').disabled).toBe(false)
    const input = peopleInput(rendered)
    await pressKey(input, 'Enter')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'build', undefined)
    consoleError.mockRestore()
  })

  it('hides the result popover on blur or Escape and keeps the query', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, grant) => profileFor(userId, grant, 'Alex'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const listbox = () => rendered.querySelector('[role="listbox"]')

    await typeDirectorySearch(rendered, 'alex')
    expect(listbox()).not.toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('true')

    // Tabbing on to the Invite button must not leave the list covering it.
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(listbox()).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(input.value).toBe('alex')
    expect(button(rendered, 'Invite').disabled).toBe(false)

    await act(async () => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(listbox()).not.toBeNull()

    // Escape closes the popover without reaching the dialog, and Enter then submits the typed id.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const dialogSawEscape = vi.fn<(event: Event) => void>()
    document.addEventListener('keydown', dialogSawEscape)
    try {
      await act(async () => input.dispatchEvent(escape))
    } finally {
      document.removeEventListener('keydown', dialogSawEscape)
    }
    expect(escape.defaultPrevented).toBe(true)
    expect(dialogSawEscape).not.toHaveBeenCalled()
    expect(listbox()).toBeNull()
    await pressKey(input, 'Enter')
    expect(stagedNames(rendered)).toEqual(['alex'])
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'build', undefined)

    // Arrow keys reopen the list instead of moving a hidden highlight.
    await typeDirectorySearch(rendered, 'alex')
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ))
    expect(listbox()).toBeNull()
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    ))
    expect(listbox()).not.toBeNull()
    expect(input.getAttribute('aria-activedescendant'))
      .toBe(`${input.getAttribute('aria-controls')}-option-0`)
  })

  it('follows the composer when chips change its height while results are open', async () => {
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'grace@example.com', name: 'Grace' }] }),
    )
    const input = peopleInput(rendered)
    const composer = rendered.querySelector<HTMLElement>('[data-testid="people-composer"]')!

    await typeDirectorySearch(rendered, 'grace')
    const listbox = rendered.querySelector<HTMLElement>('[role="listbox"]')!
    const observer = resizeObservers.find(candidate => candidate.targets.includes(composer))
    expect(observer).toBeDefined()

    // A chip wrapping on to a new line pushes the composer's bottom edge down; the list follows.
    composer.getBoundingClientRect = () =>
      ({ top: 80, bottom: 120, left: 0, right: 300, width: 300, height: 40 }) as DOMRect
    await act(async () => observer!.callback())
    expect(listbox.style.top).toBe('128px')
    expect(listbox.style.width).toBe('300px')

    await pressKey(input, 'Escape')
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(observer!.disconnect).toHaveBeenCalled()
  })

  it('ignores stale searches and selects the highlighted result with Enter', async () => {
    const first = deferred<UserDirectoryRecord[]>()
    const second = deferred<UserDirectoryRecord[]>()
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(
      query => query === 'ada' ? first.promise : second.promise,
    )
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'ada')
    await typeDirectorySearch(rendered, 'grace')
    await act(async () => {
      second.resolve([{ id: 'grace@example.com', name: 'Grace Hopper' }])
      await Promise.resolve()
    })
    expect(rendered.textContent).toContain('Grace Hopper')

    await act(async () => {
      first.resolve([{ id: 'ada@example.com', name: 'Ada Lovelace' }])
      await Promise.resolve()
    })
    expect(rendered.textContent).not.toContain('Ada Lovelace')

    const input = peopleInput(rendered)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(stagedNames(rendered)).toEqual(['Grace Hopper (grace@example.com)'])
    expect(input.value).toBe('')
  })

  it('invites everyone staged with one refetch', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, grant) => profileFor(userId, grant,
        userId === 'ada@example.com' ? 'Ada Lovelace' : 'Grace Hopper'))
    const listCollaborators = vi.fn<() => Promise<CollaboratorInfo[]>>(async () => [])
    const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(
      async query => query === 'ada' ? [{ id: 'ada@example.com', name: 'Ada Lovelace' }] : [])
    const rendered = await render(
      fakeOverseer({ addCollaborator, listCollaborators }),
      fakeAuthenticatedApi({ searchUsers }),
    )
    const loadsBefore = listCollaborators.mock.calls.length

    await typeDirectorySearch(rendered, 'ada')
    await click(rendered.querySelector<HTMLButtonElement>('[role="option"]')!)
    await typeDirectorySearch(rendered, 'grace@example.com')
    // A staged person is not suggested again.
    expect(searchUsers).toHaveBeenLastCalledWith('grace@example.com', ['dan@cloudflare.com', 'ada@example.com'])
    await pressKey(peopleInput(rendered), 'Enter')
    expect(stagedNames(rendered)).toEqual(['Ada Lovelace (ada@example.com)', 'grace@example.com'])

    await click(button(rendered, 'Invite 2 people'))

    expect(addCollaborator).toHaveBeenCalledTimes(2)
    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'build', undefined)
    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'build', undefined)
    expect(listCollaborators).toHaveBeenCalledTimes(loadsBefore + 1)
    expect(stagedNames(rendered)).toEqual([])
    expect(rendered.textContent).toContain('Added Ada Lovelace and Grace Hopper')
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Ada Lovelace and Grace Hopper as collaborators.',
      variant: 'success',
    })
  })

  it('counts the typed name in the Invite label and sends it with the chips', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, grant) => profileFor(userId, grant, userId))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    expect(button(rendered, 'Invite').disabled).toBe(false)
    await typeDirectorySearch(rendered, 'grace@example.com')

    await click(button(rendered, 'Invite 2 people'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'build', undefined)
    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'build', undefined)
  })

  it('keeps a chip staged during a pending batch and blocks removal until it settles', async () => {
    const pending = deferred<CollaboratorInfo | null>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      (userId, grant) => userId === 'ada@example.com'
        ? pending.promise
        : Promise.resolve(profileFor(userId, grant, 'Grace Hopper')))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(button(rendered, 'Inviting…').disabled).toBe(true)

    // A name staged while the batch is in flight waits for the next one; the in-flight chip
    // cannot be taken back.
    await typeDirectorySearch(rendered, 'grace@example.com')
    await pressKey(input, 'Enter')
    expect(stagedNames(rendered)).toEqual(['ada@example.com', 'grace@example.com'])
    await pressKey(input, 'Backspace')
    expect(stagedNames(rendered)).toEqual(['ada@example.com', 'grace@example.com'])
    expect(button(rendered, 'Remove ada@example.com').disabled).toBe(true)

    await act(async () => {
      pending.resolve(profileFor('ada@example.com', 'build', 'Ada Lovelace'))
      await Promise.resolve()
    })
    expect(stagedNames(rendered)).toEqual(['grace@example.com'])
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Ada Lovelace as a collaborator.',
      variant: 'success',
    })
    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(button(rendered, 'Invite').disabled).toBe(false)

    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenLastCalledWith('grace@example.com', 'build', undefined)
    expect(stagedNames(rendered)).toEqual([])
  })

  it('keeps an in-flight invite and its failure across close and reopen', async () => {
    const pending = deferred<CollaboratorInfo | null>()
    const rendered = await render(
      fakeOverseer({ addCollaborator: () => pending.promise }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    await pressKey(peopleInput(rendered), 'Enter')

    await setOpen(false)
    await setOpen(true)
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])
    expect(button(rendered, 'Remove ada@example.com').disabled).toBe(true)

    const refusal = 'Sharing is disabled for this workspace.'
    await act(async () => {
      pending.reject(new Error(refusal))
      await Promise.resolve()
    })
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain(`ada@example.com: ${refusal}`)
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
  })

  it('shows a failure that landed while the dialog was closed and drops unsent chips', async () => {
    const pending = deferred<CollaboratorInfo | null>()
    const rendered = await render(
      fakeOverseer({ addCollaborator: () => pending.promise }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    await pressKey(peopleInput(rendered), 'Enter')

    const refusal = 'Sharing is disabled for this workspace.'
    await setOpen(false)
    await act(async () => {
      pending.reject(new Error(refusal))
      await Promise.resolve()
    })
    await setOpen(true)
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain(`ada@example.com: ${refusal}`)

    // A chip that was never sent does not survive a fresh open; the failed one does.
    await typeDirectorySearch(rendered, 'grace@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    expect(stagedNames(rendered)).toEqual(['ada@example.com', 'grace@example.com'])
    await setOpen(false)
    await setOpen(true)
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])
  })

  it('counts a re-typed staged id once', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, grant) => profileFor(userId, grant, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    await typeDirectorySearch(rendered, 'ada@example.com')

    expect(rendered.textContent).not.toContain('Invite 2 people')
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'build', undefined)
  })

  it('removes a chip with its button or Backspace on an empty field', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    await typeDirectorySearch(rendered, 'grace@example.com')
    await pressKey(input, 'Enter')
    expect(stagedNames(rendered)).toEqual(['ada@example.com', 'grace@example.com'])

    await click(button(rendered, 'Remove ada@example.com'))
    expect(stagedNames(rendered)).toEqual(['grace@example.com'])

    await pressKey(input, 'Backspace')
    expect(stagedNames(rendered)).toEqual([])
    expect(button(rendered, 'Invite').disabled).toBe(true)
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('announces staged and removed people for screen readers', async () => {
    const rendered = await render(fakeOverseer(), fakeAuthenticatedApi({ searchUsers: async () => [] }))
    const input = peopleInput(rendered)
    const notice = () => rendered.querySelector('[role="status"][aria-live]')?.textContent

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    expect(notice()).toBe('Added ada@example.com.')

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    expect(notice()).toBe('ada@example.com is already listed.')
    expect(stagedNames(rendered)).toEqual(['ada@example.com'])

    await click(button(rendered, 'Remove ada@example.com'))
    expect(notice()).toBe('Removed ada@example.com.')
    expect(stagedNames(rendered)).toEqual([])
  })

  it('keeps an unknown account on its chip while the others are added', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, grant) => userId === 'nobody@example.com'
        ? null
        : profileFor(userId, grant, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    await typeDirectorySearch(rendered, 'nobody@example.com')
    await pressKey(input, 'Enter')
    await pressKey(input, 'Enter')

    expect(stagedNames(rendered)).toEqual(['nobody@example.com'])
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain('nobody@example.com: No account found for that username or email.')
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Ada Lovelace as a collaborator.',
      variant: 'success',
    })
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
    expect(rendered.textContent).toContain('Added Ada Lovelace')
    expect(input.disabled).toBe(false)
    expect(button(rendered, 'Invite').disabled).toBe(false)
  })

  it('does not expose results from the previous query', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async query => query === 'ada'
          ? [{ id: 'ada@example.com', name: 'Ada Lovelace' }]
          : [],
      }),
    )
    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.textContent).toContain('Ada Lovelace')

    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'grace')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(input.value).toBe('grace')
    expect(rendered.textContent).not.toContain('Ada Lovelace')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(rendered.querySelector('[role="option"]')).toBeNull()
    expect(stagedNames(rendered)).toEqual([])
    expect(button(rendered, 'Invite').disabled).toBe(true)
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('scrolls only the result list for keyboard navigation', async () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      id: `user${index}@example.com`,
      name: `User ${index}`,
    }))
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => results }),
    )
    await typeDirectorySearch(rendered, 'user')

    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const listbox = rendered.querySelector<HTMLDivElement>('[role="listbox"]')!
    const modalScroller = input.closest<HTMLDivElement>('.chat-panel')!
    expect(listbox.closest('dialog')).not.toBeNull()
    const targetId = `${input.getAttribute('aria-controls')}-option-6`
    const target = document.getElementById(targetId)!
    listbox.getBoundingClientRect = () => ({
      top: 100, bottom: 286, left: 0, right: 600, width: 600, height: 186,
      x: 0, y: 100, toJSON: () => ({}),
    })
    target.getBoundingClientRect = () => ({
      top: 388, bottom: 436, left: 0, right: 600, width: 600, height: 48,
      x: 0, y: 388, toJSON: () => ({}),
    })
    modalScroller.scrollTop = 31

    await act(async () => {
      for (let index = 0; index < 6; index++) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      }
    })

    expect(input.getAttribute('aria-activedescendant')).toBe(targetId)
    expect(listbox.scrollTop).toBe(150)
    expect(modalScroller.scrollTop).toBe(31)
  })

  it('keeps share links available while directory search loads or fails', async () => {
    const offline = deferred<UserDirectoryRecord[]>()
    const searchUsers = (query: string) => query === 'offline' ? offline.promise : Promise.resolve([])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
    )
    await typeDirectorySearch(rendered, 'offline')
    expect(rendered.textContent).toContain('Searching…')
    expect(button(rendered, 'Create a share link').disabled).toBe(false)

    await act(async () => {
      offline.reject(new Error('offline'))
      await Promise.resolve()
    })
    expect(rendered.textContent).toContain('User search is temporarily unavailable.')
    expect(button(rendered, 'Create a share link').disabled).toBe(false)

    await typeDirectorySearch(rendered, 'nobody')
    expect(rendered.textContent).toContain('No users found.')
    consoleError.mockRestore()
  })

  it('lists the connections recipients must verify for the dialog’s grant', async () => {
    const listObserverRequirements = vi.fn<Overseer['listObserverRequirements']>(
      async grant => grant === 'build' ? [DOC_REQUIREMENT, CRM_REQUIREMENT] : [DOC_REQUIREMENT])
    const rendered = await render(fakeOverseer({ listObserverRequirements }), fakeAuthenticatedApi(),
      METADATA, { target: GADGET_TARGET })

    expect(listObserverRequirements.mock.calls).toEqual([[{ gadgetId: 0 }]])
    const section = sectionFor(rendered, 'recipient-verification-heading')
    expect(section.textContent).toContain('Q3 planning')
    expect(section.textContent).toContain('https://docs.google.com/document/d/quarterly')
    expect(section.textContent).not.toContain('Pipeline dashboard')
  })

  it('hides verification messaging when recipients have nothing to verify', async () => {
    const rendered = await render(fakeOverseer())

    expect(rendered.querySelector('#recipient-verification-heading')).toBeNull()
    expect(rendered.textContent).not.toContain('verify any connections')
  })

  it('degrades quietly when the requirements lookup fails', async () => {
    const rendered = await render(fakeOverseer({
      listObserverRequirements: async () => { throw new Error('offline') },
    }))

    expect(rendered.textContent).toContain('Couldn’t check')
    // The rest of the modal still works.
    expect(rendered.textContent).toContain('People with access')
  })

  it('refreshes requirements when the modal regains focus', async () => {
    const listObserverRequirements = vi.fn<Overseer['listObserverRequirements']>(async () => [])
    await render(fakeOverseer({ listObserverRequirements }))
    expect(listObserverRequirements.mock.calls).toEqual([['build']])

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(listObserverRequirements.mock.calls).toEqual([['build'], ['build']])
  })

  it('keeps sharing controls live when the workspace has read restricted data', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as WorkspaceMetadata
    const rendered = await render(fakeOverseer({
      collaborators: [{
        profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
        access: { role: 'build' },
        addedBy: [],
      }],
      shareLinks: [SHARE_LINK],
    }), fakeAuthenticatedApi(), restrictedMetadata)

    // The inline warning replaces the old full-panel "can't be shared" wall: the server allows
    // sharing after containsRestrictedData is set (refusing only unverifiable producers), so the modal
    // must warn rather than block.
    expect(rendered.textContent).toContain('This workspace has read sensitive data')
    expect(rendered.textContent).not.toContain('This workspace can’t be shared')
    // The warning states the guarantee the server actually makes: recipients verify their own
    // access to the connections in scope (the panel below lists them), and output the
    // workspace has already persisted is readable by anyone who can open it. It must not claim
    // invitees are verified against "the same data" -- never-bound and since-removed producers
    // fall outside that check.
    expect(rendered.textContent).toContain('verify their own access')
    expect(rendered.textContent).not.toContain('the same data')

    // Every management affordance stays reachable: the people list with removal, the share
    // links with copying and revocation, and the invite composer.
    expect(rendered.textContent).toContain('People with access')
    expect(button(rendered, 'Remove Ada').disabled).toBe(false)
    expect(button(rendered, 'Copy Team link').disabled).toBe(false)
    expect(button(rendered, 'Revoke Team link').disabled).toBe(false)
    const usernameInput =
      rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    expect(usernameInput.disabled).toBe(false)
    await typeDirectorySearch(rendered, 'ada')
    const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')
    if (!option) throw new Error('Expected a directory search result.')
    await click(option)
    expect(button(rendered, 'Invite').disabled).toBe(false)
  })

  it('drops share-link controls but keeps revocation once the workspace is owner-invites-only', async () => {
    const ownerInvitesOnlyMetadata = {
      ...METADATA, containsRestrictedData: true, ownerInvitesOnly: true,
    } as WorkspaceMetadata
    const rendered = await render(fakeOverseer({
      requirements: [CRM_REQUIREMENT],
      shareLinks: [SHARE_LINK],
    }), fakeAuthenticatedApi(), ownerInvitesOnlyMetadata)

    expect(rendered.textContent).toContain('doesn’t allow share links')
    expect(rendered.textContent).toContain('Invite people.')
    expect(rendered.textContent).not.toContain('share a link.')
    expect(rendered.textContent).not.toContain('This workspace has read sensitive data')
    // The link restriction adds to the restricted-data caveats rather than replacing them.
    expect(rendered.textContent).toContain('verify their own access')
    expect(rendered.textContent).toContain('already saved is visible to everyone who can')

    // No way to mint or copy a link; the existing link stays listed so the owner can revoke it.
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.querySelector('button[aria-label="Copy Team link"]')).toBeNull()
    expect(button(rendered, 'Revoke Team link').disabled).toBe(false)

    // The owner still invites people directly, and sees what they will be asked to verify.
    expect(rendered.querySelector('input[aria-label="Search people"]')).not.toBeNull()
    expect(rendered.textContent).toContain('Pipeline dashboard')
    await invite(rendered, 'ada')
    expect(rendered.textContent).toContain('Added Ada')
  })

  it('hides the invite box from collaborators once the workspace is owner-invites-only', async () => {
    const ownerInvitesOnlyMetadata = {
      ...METADATA,
      ownerInvitesOnly: true,
      owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' },
    } as WorkspaceMetadata
    const rendered = await render(fakeOverseer({
      requirements: [CRM_REQUIREMENT],
    }), fakeAuthenticatedApi(), ownerInvitesOnlyMetadata)

    expect(rendered.textContent).toContain('only the owner can add people')
    expect(rendered.textContent).toContain('Manage access.')
    expect(rendered.textContent).not.toContain('Invite people')
    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.textContent).not.toContain('Recipient verification')
    expect(rendered.textContent).toContain('People with access')
  })

  it('releases the results scroll lock when a live ownerInvitesOnly update stops a collaborator inviting', async () => {
    const collaboratorMetadata = {
      ...METADATA,
      owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' },
    } as WorkspaceMetadata
    const rendered = await render(fakeOverseer(), fakeAuthenticatedApi(), collaboratorMetadata)
    const body = () => rendered.querySelector<HTMLElement>('.chat-panel')!

    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.querySelector('[role="listbox"]')).not.toBeNull()
    expect(body().classList).toContain('overflow-hidden')

    // Another session sets ownerInvitesOnly while the results are open: the search field goes
    // away without ever blurring, and the body must scroll again.
    await updateMetadata({ ...collaboratorMetadata, ownerInvitesOnly: true } as WorkspaceMetadata)
    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(body().classList).toContain('overflow-y-auto')
    expect(body().classList).not.toContain('overflow-hidden')
  })

  it('surfaces the server’s refusal when sharing is no longer allowed', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as WorkspaceMetadata
    const refusal =
      'This workspace can no longer be shared: it read sensitive data through a connection ' +
      'that has since been removed, so new collaborators can no longer be verified for ' +
      'access to that data.'
    const rendered = await render(fakeOverseer({
      addCollaborator: async () => { throw new Error(refusal) },
    }), fakeAuthenticatedApi(), restrictedMetadata)

    await invite(rendered, 'ada')

    // The attempt reaches the server and its refusal is shown verbatim on the person's chip. The
    // alert is the only readable copy of it, so it wraps rather than clipping to one line.
    expect(stagedNames(rendered)).toEqual(['Ada (ada@example.com)'])
    const alertLine = rendered.querySelector('[role="alert"] span')
    expect(alertLine?.textContent).toContain(`Ada (ada@example.com): ${refusal}`)
    expect(alertLine?.className).not.toContain('truncate')
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('does not rename a share link when its name did not change', async () => {
    const updateShareLink = vi.fn<(linkId: string, note?: string) => Promise<void>>(async () => {})
    const rendered = await render(fakeOverseer({ shareLinks: [SHARE_LINK], updateShareLink }))

    await click(button(rendered, 'Rename Team link'))
    expect(rendered.querySelector<HTMLInputElement>('input[aria-label="Share link name"]')?.value)
      .toBe('Team link')
    await click(button(rendered, 'Save'))

    expect(updateShareLink).not.toHaveBeenCalled()
    expect(rendered.querySelector('input[aria-label="Share link name"]')).toBeNull()
  })

  describe('share targets', () => {
    const ITINERARY_LINK: ShareLinkInfo = {
      linkId: 'link-itinerary', note: 'Itinerary link', created: CREATED, createdBy: CURRENT_USER,
      role: 'use', gadgetId: 0,
    }
    const BUDGET_LINK: ShareLinkInfo = {
      linkId: 'link-budget', note: 'Budget link', created: CREATED, createdBy: CURRENT_USER,
      role: 'use', gadgetId: 1,
    }
    const LEGACY_LINK: ShareLinkInfo = {
      linkId: 'link-legacy', note: 'Old link', created: CREATED, createdBy: CURRENT_USER, role: 'use',
    }
    const ALL_LINKS = [SHARE_LINK, ITINERARY_LINK, BUDGET_LINK, LEGACY_LINK]
    const EVERYONE = [BUILD_MEMBER, LEGACY_COLLABORATOR, GADGET_RECIPIENT, OTHER_GADGET_RECIPIENT]

    it('creates a workspace link from the workspace dialog', async () => {
      const createShareLink = vi.fn<Overseer['createShareLink']>(
        async () => ({ key: 'secret', linkId: 'link-new' }))
      const rendered = await render(fakeOverseer({ createShareLink }))

      await createLink(rendered)
      expect(createShareLink).toHaveBeenCalledWith('build', undefined)
      expect(rendered.textContent).toContain(`${WORKSPACE_URL}#share=secret`)
    })

    it('grants only the gadget from its dialog and links straight to it', async () => {
      const addCollaborator = vi.fn<Overseer['addCollaborator']>(
        async (userId, grant) => profileFor(userId, grant, 'Ada'))
      const createShareLink = vi.fn<Overseer['createShareLink']>(
        async () => ({ key: 'secret', linkId: 'link-new' }))
      const rendered = await renderGadget(fakeOverseer({ addCollaborator, createShareLink }))

      await invite(rendered, 'ada')
      expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', { gadgetId: 0 }, undefined)
      expect(rendered.textContent).toContain(GADGET_URL)
      await click(button(rendered, 'Copy link'))
      expect(copyToClipboard).toHaveBeenLastCalledWith(GADGET_URL)

      await createLink(rendered)
      expect(createShareLink).toHaveBeenCalledWith({ gadgetId: 0 }, undefined)
      expect(rendered.textContent).toContain(`${GADGET_URL}#share=secret`)
    })

    it('lists workspace members and legacy access, not gadget recipients, in the workspace dialog', async () => {
      const rendered = await render(fakeOverseer({ collaborators: EVERYONE }))

      const people = sectionFor(rendered, 'people-heading')
      const bea = personRow(people, 'Bea')
      expect(bea?.textContent).toContain('Member')
      expect(bea?.textContent).toContain(`Added directly by ${CURRENT_USER.id}`)
      expect(bea?.querySelector('button[aria-label="Remove Bea"]')).not.toBeNull()
      expect(people.textContent).not.toContain('People in this workspace')
      expect(personRow(people, 'Gus')).toBeNull()
      expect(personRow(people, 'Hal')).toBeNull()
      expect(personRow(people, 'Lee')).toBeNull()

      const lee = personRow(sectionFor(rendered, 'legacy-heading'), 'Lee')
      expect(lee?.textContent).toContain('All gadgets · Cannot edit')
      expect(lee?.querySelector('button[aria-label="Remove Lee"]')).not.toBeNull()
      expect(rendered.textContent).not.toContain('Gus')
    })

    it('lists the gadget’s own recipients in its dialog', async () => {
      const rendered = await renderGadget(fakeOverseer({ collaborators: EVERYONE, shareLinks: ALL_LINKS }))

      const people = sectionFor(rendered, 'people-heading')
      expect(people.textContent).toContain('People in this workspace')
      expect(people.textContent).toContain('Can edit')
      const gus = personRow(people, 'Gus')
      expect(gus?.textContent).toContain('Member')
      // Only the edge granting this gadget counts; the link to gadget 1 is another dialog's business.
      expect(gus?.textContent).toContain(`Added directly by ${CURRENT_USER.id}`)
      expect(gus?.querySelector('button[aria-label="Remove Gus"]')).not.toBeNull()
      expect(personRow(people, 'Bea')).toBeNull()
      expect(personRow(people, 'Hal')).toBeNull()

      const lee = personRow(sectionFor(rendered, 'legacy-heading'), 'Lee')
      expect(lee?.textContent).toContain('All gadgets · Cannot edit')
      expect(lee?.querySelector('button')).toBeNull()
    })

    it('removes only this gadget from a recipient in the gadget dialog', async () => {
      const affected = {
        profile: GADGET_RECIPIENT.profile,
        addedBy: GADGET_RECIPIENT.addedBy,
        oldAccess: GADGET_RECIPIENT.access,
        newAccess: { role: 'use' as const, gadgetIds: [1] },
      }
      const previewRemoveCollaborator = vi.fn<Overseer['previewRemoveCollaborator']>(async () => [affected])
      const removeCollaborator = vi.fn<Overseer['removeCollaborator']>(async () => [affected])
      const rendered = await renderGadget(fakeOverseer({
        collaborators: [GADGET_RECIPIENT], previewRemoveCollaborator, removeCollaborator,
      }))

      await click(button(rendered, 'Remove Gus'))
      await act(async () => { await Promise.resolve() })
      expect(previewRemoveCollaborator).toHaveBeenCalledWith('gus@example.com', 0)
      await click(button(rendered, 'Remove'))

      expect(removeCollaborator).toHaveBeenCalledWith('gus@example.com', [], 0)
      expect(toastAdd).toHaveBeenCalledWith({
        title: 'Removed their access to this gadget.',
        variant: 'success',
      })
    })

    it('lets a gadget recipient be found for the workspace but not a member', async () => {
      const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(async () => [])
      const rendered = await render(fakeOverseer({ collaborators: EVERYONE }), fakeAuthenticatedApi({ searchUsers }))

      await typeDirectorySearch(rendered, 'x')
      expect(searchUsers).toHaveBeenCalledWith('x', [CURRENT_USER.id, 'bea@example.com'])
    })

    it('excludes everyone who already holds the gadget from its dialog’s search', async () => {
      const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(async () => [])
      const rendered = await renderGadget(
        fakeOverseer({ collaborators: EVERYONE }), fakeAuthenticatedApi({ searchUsers }))

      await typeDirectorySearch(rendered, 'x')
      expect(searchUsers).toHaveBeenCalledWith('x', [
        CURRENT_USER.id, 'bea@example.com', 'lee@example.com', 'gus@example.com',
      ])
    })

    it('shows only the gadget’s own links in its dialog and copies them to the gadget', async () => {
      const newShareLinkKey = vi.fn<Overseer['newShareLinkKey']>(async () => ({ key: 'fresh' }))
      const rendered = await renderGadget(fakeOverseer({ shareLinks: ALL_LINKS, newShareLinkKey }))

      const links = sectionFor(rendered, 'links-heading')
      expect(links.textContent).toContain('Itinerary link')
      expect(links.textContent).not.toContain('Team link')
      expect(links.textContent).not.toContain('Budget link')
      expect(links.textContent).not.toContain('Old link')

      await click(button(rendered, 'Copy Itinerary link'))
      expect(newShareLinkKey).toHaveBeenCalledWith('link-itinerary')
      expect(copyToClipboard).toHaveBeenCalledWith(`${GADGET_URL}#share=fresh`)
    })

    it('lists workspace and legacy links in the workspace dialog but cannot copy a legacy one', async () => {
      const rendered = await render(fakeOverseer({ shareLinks: ALL_LINKS }))

      const links = sectionFor(rendered, 'links-heading')
      expect(links.textContent).toContain('Team link')
      expect(links.textContent).toContain('Old link')
      expect(links.textContent).not.toContain('Itinerary link')
      expect(links.textContent).not.toContain('Budget link')
      expect(links.querySelector('button[aria-label="Copy Team link"]')).not.toBeNull()
      expect(links.querySelector('button[aria-label="Copy Old link"]')).toBeNull()
      expect(links.querySelector('button[aria-label="Revoke Old link"]')).not.toBeNull()
    })
  })
})
