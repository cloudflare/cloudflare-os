import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceConfiguratorSession, type ConfiguratorSetup } from './ResourceConfiguratorSession'

/** The form in the frame, as the configurator runtime serves it. */
class Form extends RpcTarget {
  url = 'https://github.com/cloudflare/gadgets'
  collectResourceUrl() { return this.url }
  updateViewport() {}
  windowResized() {}
}

const ports: MessagePort[] = []
afterEach(() => {
  for (const port of ports.splice(0)) port.close()
})

const frame = {} as Window

const setup = (overrides: Partial<ConfiguratorSetup> = {}): ConfiguratorSetup => ({
  ui: {},
  acceptedResourceUrlPatterns: ['https://github.com/:owner/:repo'],
  onResize: vi.fn<ConfiguratorSetup['onResize']>(),
  onReady: vi.fn<ConfiguratorSetup['onReady']>(),
  onScroll: vi.fn<ConfiguratorSetup['onScroll']>(),
  ...overrides,
})

/** The frame's handshake, from `source` at `origin`, with the form served on the other end of its port. */
const handshake = (session: ResourceConfiguratorSession, form = new Form(), source: unknown = frame, origin = 'null') => {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  const host = newMessagePortRpcSession<RpcTarget & Record<string, (...args: unknown[]) => Promise<unknown>>>(port1, form)
  session.receive({ source: source as Window, origin, data: { type: 'handshake' }, ports: [port2] })
  return host
}

describe('ResourceConfiguratorSession', () => {
  it('collects what is chosen in its own frame', async () => {
    const session = new ResourceConfiguratorSession(() => frame, () => setup())
    handshake(session)
    await expect(session.collect()).resolves.toBe('https://github.com/cloudflare/gadgets')
  })

  it('connects only its own frame, which has no origin', async () => {
    const session = new ResourceConfiguratorSession(() => frame, () => setup())
    handshake(session, new Form(), {})
    handshake(session, new Form(), frame, 'https://example.com')
    await expect(session.collect()).rejects.toThrow('isn’t ready')
  })

  it('cuts off a frame that shakes hands twice, or loads again', async () => {
    const ready = vi.fn<ConfiguratorSetup['onReady']>()
    const twice = new ResourceConfiguratorSession(() => frame, () => setup({ onReady: ready }))
    handshake(twice)
    handshake(twice)
    await expect(twice.collect()).rejects.toThrow('no longer available')
    expect(ready).toHaveBeenLastCalledWith(false)

    const reloaded = new ResourceConfiguratorSession(() => frame, () => setup())
    reloaded.loaded()
    handshake(reloaded)
    reloaded.loaded()
    await expect(reloaded.collect()).rejects.toThrow('no longer available')
  })

  it('bounds what the frame says of its size and scrolling', async () => {
    const onResize = vi.fn<ConfiguratorSetup['onResize']>()
    const onScroll = vi.fn<ConfiguratorSetup['onScroll']>()
    const session = new ResourceConfiguratorSession(() => frame, () => setup({ onResize, onScroll }))
    const host = handshake(session)
    await host.resize(99_999, 10)
    await host.resize(Number.NaN, 200)
    await host.forwardScroll(-50_000, 'far')
    expect(onResize.mock.calls).toEqual([[4000, 80]])
    expect(onScroll).toHaveBeenCalledWith(-1000, 0)
  })

  it('takes no size from a frame that has not drawn its form yet', async () => {
    const onResize = vi.fn<ConfiguratorSetup['onResize']>()
    const session = new ResourceConfiguratorSession(() => frame, () => setup({ onResize }))
    const host = handshake(session)
    // The runtime's margin alone, before its form is rendered.
    await host.resize(8, 4)
    await host.resize(180, 172)
    expect(onResize.mock.calls).toEqual([[180, 172]])
  })

  it('asks for access one request at a time, and only where it may', async () => {
    let finish!: (asked: boolean) => void
    const ensureResources = vi.fn<NonNullable<ConfiguratorSetup['ensureResources']>>(() => new Promise((resolve) => { finish = resolve }))
    const session = new ResourceConfiguratorSession(() => frame, () => setup({ ensureResources }))
    const host = handshake(session)
    const first = host.ensureResources(['https://github.com/:owner/:repo'])
    await vi.waitFor(() => expect(ensureResources).toHaveBeenCalled())
    await expect(host.ensureResources(['https://github.com/:owner/:repo'])).rejects.toThrow('already')
    finish(true)
    await expect(first).resolves.toBe(true)

    const elsewhere = new ResourceConfiguratorSession(() => frame, () => setup())
    await expect(handshake(elsewhere).ensureResources([])).rejects.toThrow('can’t ask')
  })

  it('gives the form what it opens with, and what it may offer', async () => {
    const initialResource = { resourceUrl: 'https://github.com/a/b', resourceUrlPattern: 'https://github.com/:owner/:repo' }
    const session = new ResourceConfiguratorSession(() => frame, () => setup({ initialResource }))
    const host = handshake(session)
    await expect(host.getInitialResource()).resolves.toEqual(initialResource)
    await expect(host.getAcceptedResourceUrlPatterns()).resolves.toEqual(['https://github.com/:owner/:repo'])
  })
})
