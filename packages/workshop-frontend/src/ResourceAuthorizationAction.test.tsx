// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ResourceConfiguratorAuthorization } from '@gadgets/workshop-shared/gatekeeper'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

import { ResourceAuthorizationAction } from './ResourceAuthorizationAction'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.textContent = ''
  vi.restoreAllMocks()
})

function popup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

function render(request: ResourceConfiguratorAuthorization['request']) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <ResourceAuthorizationAction
        authorization={{
          title: 'Enable shared-drive discovery',
          description: 'Additional authority is required.',
          request,
        }}
      />,
    )
  })
  return { container, root, click: () => container.querySelector('button')!.click() }
}

function stub<T extends (...args: never[]) => unknown>(fn: T): RpcStub<T> {
  return fn as unknown as RpcStub<T>
}

describe('ResourceAuthorizationAction', () => {
  it('does not request authorization when the popup is blocked', () => {
    const request = vi.fn<() => Promise<{ url: string }>>(
      async () => ({ url: 'https://accounts.example.test/oauth' }),
    )
    vi.spyOn(window, 'open').mockReturnValue(null)
    const rendered = render(stub(request))

    act(() => rendered.click())

    expect(request).not.toHaveBeenCalled()
    expect(rendered.container.textContent).toContain('Allow popups and try again.')
  })

  it('pre-opens a safe named popup and navigates it to a valid authorization URL', async () => {
    const opened = popup()
    const request = vi.fn<() => Promise<{ url: string }>>(async () => {
      expect(opened.opener).toBeNull()
      return { url: 'https://accounts.example.test/oauth?state=secret' }
    })
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = render(stub(request))

    await act(async () => rendered.click())

    // A repeat click must reuse this tab: a stranded tab holds a superseded OAuth nonce.
    expect(window.open).toHaveBeenCalledWith('about:blank', 'gadgets-gatekeeper-authorization')
    expect(opened.location.replace).toHaveBeenCalledWith('https://accounts.example.test/oauth?state=secret')
    expect(opened.close).not.toHaveBeenCalled()
    expect(rendered.container.textContent).toContain('Complete authorization in the new tab')
  })

  it('closes the popup and reports an invalid authorization URL', async () => {
    const opened = popup()
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = render(
      stub(vi.fn(async () => ({ url: 'https://user:password@accounts.example.test/oauth' }))))

    await act(async () => rendered.click())

    expect(opened.location.replace).not.toHaveBeenCalled()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('Could not start authorization. Please try again.')
  })

  it('closes an unused popup when access is already available', async () => {
    const opened = popup()
    vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const rendered = render(stub(vi.fn(async (): Promise<{ url?: string }> => ({}))))

    await act(async () => rendered.click())

    expect(opened.close).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('Access is already available.')
  })
})
