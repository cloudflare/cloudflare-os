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
// What was added to the page: the container, or the scroll area holding it.
let mounted: HTMLElement | undefined
let root: Root | undefined
let host: RpcStub<ResourceConfiguratorHost> | undefined

afterEach(async () => {
  host?.[Symbol.dispose]()
  host = undefined
  await act(async () => root?.unmount())
  mounted?.remove()
})

// Renders the configurator and connects to its host the way the iframe runtime does.
async function connectHost(
  onEnsureResources?: (resourceUrlPatterns: string[]) => Promise<boolean>,
  { scroller }: { scroller?: HTMLElement } = {},
): Promise<RpcStub<ResourceConfiguratorHost>> {
  const frame = {
    iframeHtml: '<!doctype html><title>Configurator</title>',
    ui: new RpcStub(new EmptyUi()),
  } as unknown as ResourceConfiguratorFrame
  container = document.createElement('div')
  scroller?.append(container)
  mounted = scroller ?? container
  document.body.append(mounted)
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

// A modal scroll area 700px tall, with the frame at its top.
function scrollArea(): HTMLElement {
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 700, left: 0, right: 500, width: 500, height: 700, x: 0, y: 0, toJSON: () => ({}) })
  return scroller
}
const iframeStyle = () => document.body.querySelector('iframe')!.style

describe('SandboxedResourceConfigurator sizing', () => {
  it('gives a form taller than the window all of its height, for the modal to scroll', async () => {
    const remote = await connectHost(undefined, { scroller: scrollArea() })
    remote.resize(1500, 1500)
    await vi.waitFor(() => expect(container!.firstElementChild).toHaveProperty('style.height', '1500px'))
    expect(iframeStyle().height).toBe('1500px')
    // Clipped to the scroll area, so the rest of the form doesn't draw over the modal's footer.
    await vi.waitFor(() => expect(iframeStyle().clipPath).toBe('inset(0px 0px 800px 0px)'))
  })

  it("lets a popup past the form's end overlap the footer only while that end is in view", async () => {
    const remote = await connectHost(undefined, { scroller: scrollArea() })
    remote.resize(900, 600)
    await vi.waitFor(() => expect(iframeStyle().clipPath).toBe('inset(0px 0px 0px 0px)'))
    remote.resize(1600, 1300)
    await vi.waitFor(() => expect(iframeStyle().clipPath).toBe('inset(0px 0px 900px 0px)'))
  })

  it("lets a popup overlap the footer by no more than a popup's height", async () => {
    const remote = await connectHost(undefined, { scroller: scrollArea() })
    // A frame claiming far more than a popup past its layout is clipped a popup's worth past it.
    remote.resize(4000, 100)
    await vi.waitFor(() => expect(iframeStyle().clipPath).toBe(`inset(0px 0px ${4000 - 100 - 320}px 0px)`))
  })

  it('clips to the window when nothing scrolls the frame', async () => {
    const remote = await connectHost()
    remote.resize(1500, 1500)
    await vi.waitFor(() => expect(iframeStyle().height).toBe('1500px'))
    await vi.waitFor(() => expect(iframeStyle().clipPath).toBe(`inset(0px 0px ${1500 - window.innerHeight}px 0px)`))
  })
})
