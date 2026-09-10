// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorInfo,
  CollaboratorRole,
  GadgetMetadata,
  ObserverBindingNeed,
  Overseer,
  ShareLinkInfo,
  UserDirectoryRecord,
} from '@gadgets/workshop-shared/api'

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
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" data-testid="role-option" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    DropdownMenu,
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

import ShareModal from './ShareModal'

const METADATA = { id: 'trip-planner', title: 'Trip planner' } as GadgetMetadata
const WORKSPACE_URL = `${window.location.origin}/workspace/trip-planner`

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
  role: 'use',
}

type OverseerOverrides = {
  requirements?: Partial<Record<CollaboratorRole, ObserverBindingNeed[]>>
  listObserverRequirements?: (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
  collaborators?: CollaboratorInfo[]
  shareLinks?: ShareLinkInfo[]
  updateShareLink?: (linkId: string, note?: string) => Promise<void>
  addCollaborator?: (
    userId: string,
    role: CollaboratorRole,
    note?: string,
  ) => Promise<CollaboratorInfo | null>
}

function fakeOverseer(overrides: OverseerOverrides = {}): RpcStub<Overseer> {
  const requirements = overrides.requirements ?? { use: [], build: [] }
  return {
    listCollaborators: async () => overrides.collaborators ?? [],
    listShareLinks: async () => overrides.shareLinks ?? [],
    listObserverRequirements:
      overrides.listObserverRequirements ??
      (async (role: CollaboratorRole) => requirements[role] ?? []),
    addCollaborator: overrides.addCollaborator ?? (async () => ({
      profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
      role: 'use',
      addedBy: [],
    })),
    createShareLink: async () => ({ key: 'secret', linkId: 'link-1' }),
    updateShareLink: overrides.updateShareLink ?? (async () => {}),
  } as unknown as RpcStub<Overseer>
}

type AuthenticatedApiOverrides = {
  searchUsers?: (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
}

function fakeAuthenticatedApi(overrides: AuthenticatedApiOverrides = {}): RpcStub<AuthenticatedApi> {
  return {
    searchUsers: async (query: string, _excludeIds: string[]) => query ? [{
      id: `${query}@example.com`,
      name: query === 'ada' ? 'Ada' : query,
    }] : [],
    ...overrides,
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

function roleOption(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll<HTMLButtonElement>('[data-testid="role-option"]')]
    .find(candidate => candidate.textContent?.startsWith(label))
  if (!found) throw new Error(`No role option for “${label}”`)
  return found
}

function verificationSection(rendered: HTMLElement, headingId: string): HTMLElement {
  const section = rendered.querySelector(`#${headingId}`)?.closest('section')
  if (!section) throw new Error(`No verification section with heading “${headingId}”`)
  return section
}

async function typeDirectorySearch(rendered: HTMLElement, query: string) {
  const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => window.setTimeout(resolve, 225))
  })
}

async function invite(rendered: HTMLElement, username: string) {
  await typeDirectorySearch(rendered, username)
  const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')
  if (!option) throw new Error('Expected a directory search result.')
  await click(option)
  await click(button(rendered, 'Invite'))
}

describe('ShareModal', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    copyToClipboard.mockClear()
    toastAdd.mockClear()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(
    overseer: RpcStub<Overseer>,
    authenticatedApi = fakeAuthenticatedApi(),
    metadata: GadgetMetadata = METADATA,
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ShareModal
          open
          onClose={() => {}}
          overseer={overseer}
          metadata={metadata}
          currentUser={CURRENT_USER}
          authenticatedApi={authenticatedApi}
        />
      )
    })
    // Let the load effects settle.
    await act(async () => { await Promise.resolve() })
    return container
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
    const addCollaborator = vi.fn<(
      userId: string,
      role: CollaboratorRole,
      note?: string,
    ) => Promise<CollaboratorInfo | null>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Ada Lovelace' },
      role,
      addedBy: [],
    }))
    const existingCollaborator: CollaboratorInfo = {
      profile: { type: 'user', id: 'maximo@cloudflare.com', name: 'maximo' },
      role: 'use',
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

    await click(rendered.querySelector<HTMLButtonElement>('[role="option"]')!)
    expect(rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')?.value)
      .toBe('Ada Lovelace')
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@cloudflare.com', 'use', undefined)
  })

  it('excludes the workspace owner when the caller is a collaborator', async () => {
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [])
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
      { ...METADATA, owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' } } as GadgetMetadata,
    )

    await typeDirectorySearch(rendered, 'own')
    expect(searchUsers).toHaveBeenCalledWith('own', ['dan@cloudflare.com', 'owner@cloudflare.com'])
  })

  it('submits a typed exact id when the directory has not indexed the account', async () => {
    const addCollaborator = vi.fn<(
      userId: string,
      role: CollaboratorRole,
      note?: string,
    ) => Promise<CollaboratorInfo | null>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Dormant User' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('No users found.')
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))

    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'use', undefined)
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
    // Enter picks the highlighted match rather than submitting the raw text.
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(input.value).toBe('Alex Smith')
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('still invites the typed canonical id when unrelated users match it', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Alex' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )

    // The directory is backfilled lazily, so "alex" may be a real account it has not indexed yet.
    await typeDirectorySearch(rendered, 'alex')
    expect(rendered.textContent).toContain('Alexander')
    expect(button(rendered, 'Invite').disabled).toBe(false)
    await click(button(rendered, 'Invite'))
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'use', undefined)
  })

  it('falls back to a direct invite when the directory lookup fails', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Dormant User' },
      role,
      addedBy: [],
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => { throw new Error('offline') } }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('User search is temporarily unavailable.')
    expect(button(rendered, 'Invite').disabled).toBe(false)
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'use', undefined)
    consoleError.mockRestore()
  })

  it('hides the result popover on blur or Escape and keeps the query', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Alex' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const listbox = () => rendered.querySelector('[role="listbox"]')

    await typeDirectorySearch(rendered, 'alex')
    expect(listbox()).not.toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('true')

    // Tabbing on to the role picker or Invite button must not leave the list covering them.
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
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'use', undefined)

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

    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(input.value).toBe('Grace Hopper')
  })

  it('scrolls the keyboard-active directory result into view', async () => {
    const scrollIntoView = vi.fn<Element['scrollIntoView']>()
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    try {
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
      await act(async () => {
        for (let index = 0; index < 6; index++) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        }
      })

      const activeId = input.getAttribute('aria-activedescendant')
      expect(activeId).toBe(`${input.getAttribute('aria-controls')}-option-6`)
      expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById(activeId!))
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      }
    }
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

  it('names the connections a recipient must verify for the selected role', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))

    // The invite composer defaults to "App only".
    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('Pipeline dashboard')

    await click(roleOption(rendered, 'Workspace'))

    expect(rendered.textContent).toContain('Pipeline dashboard')
  })

  it('keeps invite and share-link requirements tied to their own role pickers', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))

    await click(button(rendered, 'Create a share link'))
    expect(rendered.querySelector('#recipient-verification-heading')).not.toBeNull()
    expect(rendered.querySelector('#invite-verification-heading')).toBeNull()
    expect(rendered.querySelector('#link-verification-heading')).toBeNull()

    const buildOptions = [...rendered.querySelectorAll<HTMLButtonElement>('[data-testid="role-option"]')]
      .filter(option => option.textContent?.startsWith('Workspace'))
    expect(buildOptions).toHaveLength(2)
    await click(buildOptions[1])

    expect(verificationSection(rendered, 'invite-verification-heading').textContent)
      .not.toContain('Pipeline dashboard')
    expect(verificationSection(rendered, 'link-verification-heading').textContent)
      .toContain('Pipeline dashboard')

    await click(button(rendered, 'Create link'))
    expect(verificationSection(rendered, 'link-verification-heading').textContent)
      .toContain('Pipeline dashboard')
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
    const listObserverRequirements = vi.fn<
      (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
    >(async () => [])
    await render(fakeOverseer({ listObserverRequirements }))
    expect(listObserverRequirements).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(listObserverRequirements).toHaveBeenCalledTimes(4)
  })

  it('keeps sharing controls live when the workspace has read restricted data', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as GadgetMetadata
    const rendered = await render(fakeOverseer({
      collaborators: [{
        profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
        role: 'use',
        addedBy: [],
      }],
      shareLinks: [SHARE_LINK],
    }), fakeAuthenticatedApi(), restrictedMetadata)

    // The inline warning replaces the old full-panel "can't be shared" wall: the server allows
    // sharing after the restricted latch (refusing only unverifiable producers), so the modal
    // must warn rather than block.
    expect(rendered.textContent).toContain('This workspace has read sensitive data')
    expect(rendered.textContent).not.toContain('This workspace can’t be shared')
    // The warning states the guarantee the server actually makes: verification is scoped to the
    // recipient's role (the panel below lists the connections per level), and output the
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

  it('surfaces the server’s refusal when sharing is no longer allowed', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as GadgetMetadata
    const refusal =
      'This workspace can no longer be shared: it read sensitive data through a connection ' +
      'that has since been removed, so new collaborators can no longer be verified for ' +
      'access to that data.'
    const rendered = await render(fakeOverseer({
      addCollaborator: async () => { throw new Error(refusal) },
    }), fakeAuthenticatedApi(), restrictedMetadata)

    await invite(rendered, 'ada')

    // The attempt reaches the server and its refusal is shown verbatim.
    expect(toastAdd).toHaveBeenCalledWith({ title: refusal, variant: 'error' })
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
})
