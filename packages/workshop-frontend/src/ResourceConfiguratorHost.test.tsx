// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub, RpcTarget } from 'capnweb'
import type { ResourceConfiguratorAuthorization } from '@gadgets/workshop-shared/gatekeeper'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./SandboxedResourceConfigurator', () => ({
  default: () => <div data-testid="configurator" />,
}))

import ResourceConfiguratorHost, {
  disposeConfiguratorFrame, type ConfiguratorFrameState,
} from './ResourceConfiguratorHost'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function stub<T extends (...args: never[]) => unknown>(fn: T): RpcStub<T> {
  return fn as unknown as RpcStub<T>
}

const PATTERN = 'https://drive.google.com/drive/folders/:folderId'
const ACCOUNT = 7

function state(
  auth?: ResourceConfiguratorAuthorization,
  overrides: Partial<ConfiguratorFrameState> = {},
): ConfiguratorFrameState {
  return {
    key: 1,
    frame: { iframeHtml: '<html></html>', ui: {} as RpcStub<RpcTarget>, authorization: auth },
    accountId: ACCOUNT,
    resourceUrlPattern: PATTERN,
    ...overrides,
  }
}

function popup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

function host(hostState: ConfiguratorFrameState | null) {
  return (
    <ResourceConfiguratorHost
      state={hostState}
      accountId={ACCOUNT}
      resourceUrlPattern={PATTERN}
      loading={false}
      error={null}
      disabled={false}
    />
  )
}

function renderHost(hostState: ConfiguratorFrameState | null) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(host(hostState)))
  return { container, root }
}

function authorization(request: ResourceConfiguratorAuthorization['request']): ResourceConfiguratorAuthorization {
  return {
    title: 'Enable shared-drive discovery',
    description: 'Additional authority is required.',
    request,
  }
}

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.textContent = ''
  vi.restoreAllMocks()
})

describe('ResourceConfiguratorHost', () => {
  // A superseded frame is cleared from an effect, so it outlives the selection by one render.
  it('renders nothing for a frame from another account or resource type', () => {
    const request = stub(vi.fn(async () => ({ url: 'https://accounts.example.test/oauth' })))

    for (const stale of [
      state(authorization(request), { accountId: ACCOUNT + 1 }),
      state(authorization(request), { resourceUrlPattern: 'https://mail.google.com/*' }),
    ]) {
      expect(renderHost(stale).container.textContent).toBe('')
    }

    expect(renderHost(state(authorization(request))).container.querySelector('button')).not.toBeNull()
  })

  it('closes a pending blank popup and ignores its result after frame replacement', async () => {
    const opened = popup()
    const pending = deferred<{ url?: string }>()
    const request = stub(vi.fn(() => pending.promise))
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = renderHost(state(authorization(request)))

    act(() => rendered.container.querySelector('button')!.click())
    act(() => rendered.root.render(host(state(undefined, { key: 2 }))))
    expect(opened.close).toHaveBeenCalledOnce()

    await act(async () => pending.resolve({ url: 'https://accounts.example.test/oauth' }))

    expect(opened.location.replace).not.toHaveBeenCalled()
  })
})

describe('disposeConfiguratorFrame', () => {
  it('attempts to dispose both frame capabilities', () => {
    const requestDispose = vi.fn<() => void>()
    const request = Object.assign(vi.fn<() => void>(), { [Symbol.dispose]: requestDispose })
    const uiError = new Error('ui disposal failed')
    const uiDispose = vi.fn<() => void>(() => { throw uiError })
    const hostFrame = state(
      authorization(request as unknown as ResourceConfiguratorAuthorization['request'])).frame
    hostFrame.ui = { [Symbol.dispose]: uiDispose } as unknown as RpcStub<RpcTarget>

    expect(() => disposeConfiguratorFrame(hostFrame)).toThrow(uiError)
    expect(uiDispose).toHaveBeenCalledOnce()
    expect(requestDispose).toHaveBeenCalledOnce()
  })
})
