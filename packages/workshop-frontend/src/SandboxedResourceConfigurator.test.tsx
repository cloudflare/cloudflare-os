// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceConfiguratorFrame, ResourceConfiguratorHost } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))

vi.mock('./errorReporting', () => ({
  forwardTrustedFrameError: () => false,
}))

class EmptyUi extends RpcTarget {}

const GRANT = 'https://docs.google.com/import'

let container: HTMLDivElement | undefined
let root: Root | undefined
let host: RpcStub<ResourceConfiguratorHost> | undefined

afterEach(async () => {
  host?.[Symbol.dispose]()
  host = undefined
  await act(async () => root?.unmount())
  container?.remove()
})

// Renders the configurator and connects to its host the way the iframe runtime does.
async function connectHost(
  onEnsureResources?: (resourceUrlPatterns: string[]) => Promise<boolean>,
): Promise<RpcStub<ResourceConfiguratorHost>> {
  const frame = {
    iframeHtml: '<!doctype html><title>Configurator</title>',
    ui: new RpcStub(new EmptyUi()),
  } as unknown as ResourceConfiguratorFrame
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <SandboxedResourceConfigurator
      frame={frame}
      acceptedResourceUrlPatterns={['https://docs.google.com/document/d/:id']}
      onEnsureResources={onEnsureResources}
    />))

  const iframe = await vi.waitFor(() => {
    const element = document.body.querySelector('iframe')
    expect(element).not.toBeNull()
    return element!
  })
  const { port1, port2 } = new MessageChannel()
  host = newMessagePortRpcSession<ResourceConfiguratorHost>(port1)
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake' },
    origin: 'null',
    source: iframe.contentWindow,
    ports: [port2],
  }))
  return host
}

describe('SandboxedResourceConfigurator access requests', () => {
  it("passes the configurator's patterns to the Workshop and returns its answer", async () => {
    const onEnsureResources = vi.fn<(patterns: string[]) => Promise<boolean>>(async () => false)
    const configuratorHost = await connectHost(onEnsureResources)

    await expect(configuratorHost.ensureResources([GRANT])).resolves.toBe(false)
    expect(onEnsureResources).toHaveBeenCalledExactlyOnceWith([GRANT])
  })

  it('refuses a second request while one is in flight, and accepts one after it settles', async () => {
    let finish: ((granted: boolean) => void) | undefined
    const onEnsureResources = vi.fn<(patterns: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(true)
    const configuratorHost = await connectHost(onEnsureResources)

    const first = configuratorHost.ensureResources([GRANT])
    await vi.waitFor(() => expect(onEnsureResources).toHaveBeenCalledTimes(1))
    await expect(configuratorHost.ensureResources([GRANT]))
      .rejects.toThrow('An access request is already in progress.')

    finish!(false)
    await expect(first).resolves.toBe(false)
    await expect(configuratorHost.ensureResources([GRANT])).resolves.toBe(true)
    expect(onEnsureResources).toHaveBeenCalledTimes(2)
  })

  it("passes the Workshop's rejection back to the configurator", async () => {
    const configuratorHost = await connectHost(async () => {
      throw new Error('Authentication was cancelled.')
    })

    await expect(configuratorHost.ensureResources([GRANT]))
      .rejects.toThrow('Authentication was cancelled.')
  })

  it('refuses requests when the Workshop serves none', async () => {
    const configuratorHost = await connectHost()

    await expect(configuratorHost.ensureResources([GRANT]))
      .rejects.toThrow('This configurator cannot request access here.')
  })
})
