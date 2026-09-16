// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub, RpcTarget } from 'capnweb'
import type {
  ResourceConfiguratorAuthorization,
  ResourceConfiguratorFrame,
} from '@gadgets/workshop-shared/gatekeeper'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./SandboxedResourceConfigurator', () => ({
  default: () => <div data-testid="configurator" />,
}))

import ResourceConfiguratorHost, { disposeConfiguratorFrame } from './ResourceConfiguratorHost'

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

function frame(auth?: ResourceConfiguratorAuthorization): ResourceConfiguratorFrame {
  return {
    iframeHtml: '<html></html>',
    ui: {} as RpcStub<RpcTarget>,
    authorization: auth,
  }
}

function popup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

function renderHost(hostFrame: ResourceConfiguratorFrame, frameKey = 1) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ResourceConfiguratorHost
        frame={hostFrame}
        frameKey={frameKey}
        loading={false}
        error={null}
        disabled={false}
      />,
    )
  })
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

describe('ResourceConfiguratorHost authorization', () => {
  it('does not request authorization when the popup is blocked', () => {
    const request = vi.fn<() => Promise<{ url: string }>>(
      async () => ({ url: 'https://accounts.example.test/oauth' }),
    )
    vi.spyOn(window, 'open').mockReturnValue(null)
    const rendered = renderHost(frame(authorization(stub(request))))
    roots.push(rendered.root)

    act(() => rendered.container.querySelector('button')!.click())

    expect(request).not.toHaveBeenCalled()
    expect(rendered.container.textContent).toContain('Allow popups and try again.')
  })

  it('pre-opens a safe popup and navigates it to a valid authorization URL', async () => {
    const opened = popup()
    const request = vi.fn<() => Promise<{ url: string }>>(async () => {
      expect(opened.opener).toBeNull()
      return { url: 'https://accounts.example.test/oauth?state=secret' }
    })
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = renderHost(frame(authorization(stub(request))))
    roots.push(rendered.root)

    await act(async () => rendered.container.querySelector('button')!.click())

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(opened.location.replace).toHaveBeenCalledWith('https://accounts.example.test/oauth?state=secret')
    expect(opened.close).not.toHaveBeenCalled()
    expect(rendered.container.textContent).toContain('Complete authorization in the new tab')
  })

  it('closes the popup and reports an invalid authorization URL', async () => {
    const opened = popup()
    const request = stub(vi.fn(async () => ({ url: 'https://user:password@accounts.example.test/oauth' })))
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = renderHost(frame(authorization(request)))
    roots.push(rendered.root)

    await act(async () => rendered.container.querySelector('button')!.click())

    expect(opened.location.replace).not.toHaveBeenCalled()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('Could not start authorization. Please try again.')
  })

  it('closes an unused popup when access is already available', async () => {
    const opened = popup()
    const request = stub(vi.fn(async (): Promise<{ url?: string }> => ({})))
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = renderHost(frame(authorization(request)))
    roots.push(rendered.root)

    await act(async () => rendered.container.querySelector('button')!.click())

    expect(opened.close).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('Access is already available.')
  })

  it('closes a pending blank popup and ignores its result after frame replacement', async () => {
    const opened = popup()
    const pending = deferred<{ url?: string }>()
    const request = stub(vi.fn(() => pending.promise))
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = renderHost(frame(authorization(request)), 1)
    roots.push(rendered.root)

    act(() => rendered.container.querySelector('button')!.click())
    act(() => {
      rendered.root.render(
        <ResourceConfiguratorHost
          frame={frame()}
          frameKey={2}
          loading={false}
          error={null}
          disabled={false}
        />,
      )
    })
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
    const hostFrame = frame(authorization(request as unknown as ResourceConfiguratorAuthorization['request']))
    hostFrame.ui = { [Symbol.dispose]: uiDispose } as unknown as RpcStub<RpcTarget>

    expect(() => disposeConfiguratorFrame(hostFrame)).toThrow(uiError)
    expect(uiDispose).toHaveBeenCalledOnce()
    expect(requestDispose).toHaveBeenCalledOnce()
  })
})
