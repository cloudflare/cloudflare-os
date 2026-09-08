// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorRole,
  GadgetMetadata,
  ObserverBindingNeed,
  Overseer,
  ShareLinkInfo,
} from '@gadgets/workshop-shared/api'

const toastAdd = vi.hoisted(() => vi.fn<(toast: { title?: string; variant?: string }) => void>())

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
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

const INTERNAL_SHARE_LINK: ShareLinkInfo = {
  ...SHARE_LINK,
  linkId: 'internal-link-1',
  note: 'Totango link',
  recipientPolicy: { type: 'verified-sso-email-domain', emailDomain: 'totango.com' },
}

type OverseerOverrides = {
  requirements?: Partial<Record<CollaboratorRole, ObserverBindingNeed[]>>
  listObserverRequirements?: (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
  shareLinks?: ShareLinkInfo[]
  updateShareLink?: (linkId: string, note?: string) => Promise<void>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function testRpcStub<T extends object>(
  methods: Record<string, (...args: any[]) => any>,
  onDispose?: () => void,
): RpcStub<T> {
  let disposed = false
  const stub: Record<PropertyKey, unknown> = {
    dup: () => testRpcStub<T>(methods, onDispose),
    [Symbol.dispose]: () => { disposed = true; onDispose?.() },
  }
  for (const [name, method] of Object.entries(methods)) {
    stub[name] = (...args: any[]) => {
      if (disposed) throw new Error('Attempted to use RPC stub after it has been disposed.')
      return method(...args)
    }
  }
  return stub as RpcStub<T>
}

function fakeOverseer(overrides: OverseerOverrides = {}): RpcStub<Overseer> {
  const requirements = overrides.requirements ?? { use: [], build: [] }
  return testRpcStub<Overseer>({
    listCollaborators: async () => [],
    listShareLinks: async () => overrides.shareLinks ?? [],
    listObserverRequirements:
      overrides.listObserverRequirements ??
      (async (role: CollaboratorRole) => requirements[role] ?? []),
    addCollaborator: async () => ({
      profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
      role: 'use',
      addedBy: [],
    }),
    createShareLink: async () => ({ key: 'secret', linkId: 'link-1' }),
    updateShareLink: overrides.updateShareLink ?? (async () => {}),
  })
}

const fakeAuthenticatedApi = {} as RpcStub<AuthenticatedApi>

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

async function invite(rendered: HTMLElement, username: string) {
  const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, username)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

  async function renderModal(
    overseer: RpcStub<Overseer>,
    metadata: GadgetMetadata = METADATA,
    open = true,
  ) {
    if (!container) {
      container = document.createElement('div')
      document.body.append(container)
    }
    root ??= createRoot(container)
    await act(async () => {
      root!.render(
        <ShareModal
          open={open}
          onClose={() => {}}
          overseer={overseer}
          metadata={metadata}
          currentUser={CURRENT_USER}
          authenticatedApi={fakeAuthenticatedApi}
        />,
      )
    })
    // Let the load effects settle.
    await act(async () => { await Promise.resolve() })
    return container
  }

  async function render(overseer: RpcStub<Overseer>, metadata: GadgetMetadata = METADATA) {
    return renderModal(overseer, metadata, true)
  }

  it('reveals the workspace link to send after a direct invite', async () => {
    const rendered = await render(fakeOverseer())
    expect(rendered.textContent).not.toContain(WORKSPACE_URL)

    await invite(rendered, 'ada')

    expect(rendered.textContent).toContain('Added Ada')
    expect(rendered.textContent).toContain(WORKSPACE_URL)
  })

  it('copies the plain workspace link, never a share-link secret', async () => {
    const rendered = await render(fakeOverseer())
    await invite(rendered, 'ada')

    await click(button(rendered, 'Copy link'))

    expect(copyToClipboard).toHaveBeenCalledWith(WORKSPACE_URL)
    expect(rendered.textContent).toContain('Link copied')
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

  it('renders Finance as invite-only with no build-role or share-link controls', async () => {
    const rendered = await render(fakeOverseer({ shareLinks: [SHARE_LINK] }), {
      ...METADATA,
      originHubId: 'finance',
    })

    expect(rendered.textContent).toContain('Invite-only Finance workspace')
    expect(rendered.textContent).toContain('Gadget only')
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.textContent).not.toContain('Share links')
    expect([...rendered.querySelectorAll('[data-testid="role-option"]')]
      .some(option => option.textContent?.startsWith('Workspace'))).toBe(false)
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

  it('labels internal share links with verified SSO domain guidance', async () => {
    const rendered = await render(fakeOverseer({ shareLinks: [INTERNAL_SHARE_LINK] }))

    expect(rendered.textContent).toContain('Internal link')
    expect(rendered.textContent).toContain('only verified @totango.com SSO users can open')
  })

  it('keeps a duplicated overseer alive for the create-link refresh after the parent closes', async () => {
    let rootDispose!: () => void
    const listShareLinks = vi.fn<() => Promise<ShareLinkInfo[]>>(async () => [])
    const overseer = testRpcStub<Overseer>({
      listCollaborators: async () => [],
      listShareLinks,
      listObserverRequirements: async () => [],
      createShareLink: async () => {
        rootDispose()
        return { key: 'secret', linkId: 'link-1' }
      },
    })
    rootDispose = () => overseer[Symbol.dispose]()
    const rendered = await render(overseer)
    listShareLinks.mockClear()

    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))

    expect(rendered.textContent).toContain(`${WORKSPACE_URL}#share=secret`)
    expect(listShareLinks).toHaveBeenCalledOnce()
  })

  it('ignores a stale create-link success after close and same-workspace reopen', async () => {
    const created = deferred<{ key: string; linkId: string }>()
    const overseer = testRpcStub<Overseer>({
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
      createShareLink: () => created.promise,
    })
    const rendered = await render(overseer)

    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))
    expect(rendered.textContent).toContain('Creating…')

    await renderModal(overseer, METADATA, false)
    await renderModal(overseer, METADATA, true)
    expect(rendered.textContent).toContain('Create a share link')

    created.resolve({ key: 'late-secret', linkId: 'late-link' })
    await act(async () => { await Promise.resolve() })

    expect(rendered.textContent).not.toContain('late-secret')
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
  })

  it('ignores a stale create-link error after close and same-workspace reopen', async () => {
    const created = deferred<{ key: string; linkId: string }>()
    const overseer = testRpcStub<Overseer>({
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
      createShareLink: () => created.promise,
    })
    const rendered = await render(overseer)

    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))
    await renderModal(overseer, METADATA, false)
    await renderModal(overseer, METADATA, true)

    created.reject(new Error('late failure'))
    await act(async () => { await Promise.resolve() })

    expect(rendered.textContent).not.toContain('late failure')
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'late failure' }))
  })

  it('releases duplicated overseer handles after stale and live share actions', async () => {
    let liveHandles = 0
    const created = deferred<{ key: string; linkId: string }>()
    const methods = {
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
      createShareLink: () => created.promise,
    }
    const overseer = {
      ...testRpcStub<Overseer>(methods),
      dup: () => {
        liveHandles += 1
        return testRpcStub<Overseer>(methods, () => { liveHandles -= 1 })
      },
    } as RpcStub<Overseer>
    const rendered = await render(overseer)

    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))
    await renderModal(overseer, METADATA, false)
    created.resolve({ key: 'released-secret', linkId: 'released-link' })
    await act(async () => { await Promise.resolve() })

    expect(liveHandles).toBe(0)
  })

  it('resets busy latches when the open modal receives a new overseer for the same workspace', async () => {
    const oldCreate = deferred<{ key: string; linkId: string }>()
    const newCreate = deferred<{ key: string; linkId: string }>()
    const oldOverseer = testRpcStub<Overseer>({
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
      createShareLink: () => oldCreate.promise,
    })
    const createShareLink = vi.fn<() => Promise<{ key: string; linkId: string }>>(
      () => newCreate.promise,
    )
    const newOverseer = testRpcStub<Overseer>({
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
      createShareLink,
    })
    const rendered = await render(oldOverseer)

    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))
    expect(rendered.textContent).toContain('Creating…')

    await renderModal(newOverseer, METADATA, true)
    expect(rendered.textContent).toContain('Create a share link')
    await click(button(rendered, 'Create a share link'))
    await click(button(rendered, 'Create link'))
    expect(createShareLink).toHaveBeenCalledOnce()
    expect(rendered.textContent).toContain('Creating…')

    oldCreate.resolve({ key: 'old-secret', linkId: 'old-link' })
    await act(async () => { await Promise.resolve() })
    expect(rendered.textContent).toContain('Creating…')
    expect(rendered.textContent).not.toContain('old-secret')

    newCreate.resolve({ key: 'new-secret', linkId: 'new-link' })
    await act(async () => { await Promise.resolve() })
    expect(rendered.textContent).toContain(`${WORKSPACE_URL}#share=new-secret`)
  })

  it('reports load failure when duplicating the overseer fails during initial load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = {
      dup: () => { throw new Error('disposed root') },
    } as unknown as RpcStub<Overseer>

    await render(overseer)

    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to load sharing info',
      variant: 'error',
    }))
  })
})
