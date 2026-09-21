// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BlueprintPublicInfo, PublicApi } from '@gadgets/workshop-shared/api'

const route = vi.hoisted(() => ({ id: 'blueprint-a' }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: route.id }),
  useNavigate: () => vi.fn<() => void>(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn<() => void>() } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    authenticatedApi: null,
    isLoading: false,
    login: vi.fn<() => void>(),
  }),
}))

vi.mock('@cloudflare/kumo', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const PassThrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Dialog = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
        open === false ? null : <>{children}</>,
      Trigger: ({ render }: { render: ReactElement }) => render,
      Title: PassThrough,
      Description: PassThrough,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({}),
    },
  )
  const DropdownMenu = Object.assign(PassThrough, {
    Trigger: ({ render }: { render: ReactElement }) => render,
    Content: PassThrough,
    Item: PassThrough,
    Separator: () => null,
  })
  const Select = Object.assign(PassThrough, { Option: PassThrough })

  return {
    Button: ({ children, ...props }: ComponentProps<'button'>) => (
      <button type="button" {...props}>{children}</button>
    ),
    Dialog,
    DropdownMenu,
    Select,
    Tooltip: PassThrough,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
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

vi.mock('./gatekeeper-modal/AccountChooser', () => ({ AccountChooser: () => null }))
vi.mock('./ResourceConfiguratorHost', () => ({ default: () => null }))

import BlueprintLandingPage from './BlueprintLandingPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function blueprint(id: string, title: string): BlueprintPublicInfo {
  return {
    id,
    metadata: {
      title,
      description: '',
      author: { type: 'user', id: 'author', name: 'Author' },
      created: new Date('2026-08-01T00:00:00Z'),
      version: 1,
      lastUpdated: new Date('2026-08-01T00:00:00Z'),
      bindings: {},
    },
  }
}

describe('BlueprintLandingPage route changes', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    route.id = 'blueprint-a'
  })

  async function render(rpcStub: RpcStub<PublicApi>) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={rpcStub} />))
  }

  async function navigateTo(id: string, rpcStub: RpcStub<PublicApi>) {
    route.id = id
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={rpcStub} />))
  }

  it('ignores an earlier route response that finishes after the current route response', async () => {
    const requestA = deferred<BlueprintPublicInfo | null>()
    const requestB = deferred<BlueprintPublicInfo | null>()
    const rpcStub = {
      getBlueprint: vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>((id: string) =>
        id === 'blueprint-a' ? requestA.promise : requestB.promise),
    } as unknown as RpcStub<PublicApi>

    await render(rpcStub)
    await navigateTo('blueprint-b', rpcStub)

    await act(async () => {
      requestB.resolve(blueprint('blueprint-b', 'CURRENT BLUEPRINT'))
      await requestB.promise
    })
    expect(container!.textContent).toContain('CURRENT BLUEPRINT')

    await act(async () => {
      requestA.resolve(blueprint('blueprint-a', 'STALE BLUEPRINT'))
      await requestA.promise
    })
    expect(container!.textContent).toContain('CURRENT BLUEPRINT')
    expect(container!.textContent).not.toContain('STALE BLUEPRINT')
  })

  it('hides the previous blueprint in the first render of a new route', async () => {
    const requestA = deferred<BlueprintPublicInfo | null>()
    const requestB = deferred<BlueprintPublicInfo | null>()
    const rpcStub = {
      getBlueprint: vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>((id: string) =>
        id === 'blueprint-a' ? requestA.promise : requestB.promise),
    } as unknown as RpcStub<PublicApi>

    await render(rpcStub)
    await act(async () => {
      requestA.resolve(blueprint('blueprint-a', 'BLUEPRINT A'))
      await requestA.promise
    })
    expect(container!.textContent).toContain('BLUEPRINT A')

    let firstRenderText = ''
    act(() => {
      route.id = 'blueprint-b'
      flushSync(() => root!.render(<BlueprintLandingPage rpcStub={rpcStub} />))
      firstRenderText = container!.textContent ?? ''
    })

    expect(firstRenderText).toContain('Loading blueprint...')
    expect(firstRenderText).not.toContain('BLUEPRINT A')
  })

  it('clears the loaded blueprint when the next route is not found', async () => {
    const requestA = deferred<BlueprintPublicInfo | null>()
    const requestB = deferred<BlueprintPublicInfo | null>()
    const rpcStub = {
      getBlueprint: vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>((id: string) =>
        id === 'blueprint-a' ? requestA.promise : requestB.promise),
    } as unknown as RpcStub<PublicApi>

    await render(rpcStub)
    await act(async () => {
      requestA.resolve(blueprint('blueprint-a', 'BLUEPRINT A'))
      await requestA.promise
    })
    expect(container!.textContent).toContain('BLUEPRINT A')

    await navigateTo('blueprint-b', rpcStub)
    expect(container!.textContent).toContain('Loading blueprint...')
    expect(container!.textContent).not.toContain('BLUEPRINT A')

    await act(async () => {
      requestB.resolve(null)
      await requestB.promise
    })
    expect(container!.textContent).toContain('Blueprint not found')
    expect(container!.textContent).not.toContain('BLUEPRINT A')
  })

  it('clears the loaded blueprint when loading the next route fails', async () => {
    const requestA = deferred<BlueprintPublicInfo | null>()
    const requestB = deferred<BlueprintPublicInfo | null>()
    const rpcStub = {
      getBlueprint: vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>((id: string) =>
        id === 'blueprint-a' ? requestA.promise : requestB.promise),
    } as unknown as RpcStub<PublicApi>

    await render(rpcStub)
    await act(async () => {
      requestA.resolve(blueprint('blueprint-a', 'BLUEPRINT A'))
      await requestA.promise
    })
    expect(container!.textContent).toContain('BLUEPRINT A')

    await navigateTo('blueprint-b', rpcStub)
    expect(container!.textContent).toContain('Loading blueprint...')
    expect(container!.textContent).not.toContain('BLUEPRINT A')

    await act(async () => {
      requestB.reject(new Error('Failed to load B'))
      await requestB.promise.catch(() => {})
    })
    expect(container!.textContent).toContain('Couldn’t load blueprint')
    expect(container!.textContent).toContain('Failed to load B')
    expect(container!.textContent).not.toContain('BLUEPRINT A')
  })
})
