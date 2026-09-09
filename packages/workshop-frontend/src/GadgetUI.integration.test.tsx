// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetClient, UiBundle } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

vi.mock('@cloudflare/kumo', () => {
  // Enough of the banner to read what the user is being told when a load fails.
  const Banner = Object.assign(
    ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
      <div data-testid="banner">{title}: {description}</div>
    ),
    { Action: ({ children }: { children: ReactNode }) => <>{children}</> },
  )
  return {
    Banner,
    Loader: () => null,
    Text: ({ children }: { children: ReactNode }) => children,
  }
})

import GadgetUI from './GadgetUI'

interface TestGadget {
  read(): string
  child(): TestChild
  subscribe(callback: RpcStub<TestSubscriber>): TestSubscription
}

interface TestChild {
  read(): string
}

interface TestSubscriber {
  update(value: string): void
}

interface TestSubscription {}

class TestChildTarget extends RpcTarget implements TestChild {
  constructor(private value: string) {
    super()
  }

  read() {
    return this.value
  }
}

class TestSubscriptionTarget extends RpcTarget implements TestSubscription {
  constructor(private unsubscribe: () => void) {
    super()
  }

  [Symbol.dispose]() {
    this.unsubscribe()
  }
}

class TestGadgetTarget extends RpcTarget implements TestGadget {
  private subscribers = new Set<RpcStub<TestSubscriber>>()

  constructor(private value: string, private onDispose?: () => void) {
    super()
  }

  read() {
    return this.value
  }

  child() {
    return new TestChildTarget(this.value)
  }

  async subscribe(callback: RpcStub<TestSubscriber>) {
    const subscriber = callback.dup()
    this.subscribers.add(subscriber)
    const unsubscribe = () => {
      if (this.subscribers.delete(subscriber)) subscriber[Symbol.dispose]()
    }
    subscriber.onRpcBroken(unsubscribe)
    try {
      await subscriber.update(this.value)
      return new TestSubscriptionTarget(unsubscribe)
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  [Symbol.dispose]() {
    for (const subscriber of this.subscribers) subscriber[Symbol.dispose]()
    this.subscribers.clear()
    this.onDispose?.()
  }
}

class TestCallbacks extends RpcTarget implements TestSubscriber {
  closed = false

  constructor(private values: string[], private reconnect: () => void) {
    super()
  }

  update(value: string) {
    this.values.push(value)
  }

  [Symbol.dispose]() {
    if (!this.closed) this.reconnect()
  }
}

// The same digest the host computes over the code it is handed (Web Crypto, hex).
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

function fakeGadget(
  value: string,
  bundleCode: string,
  connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(
    async () => new RpcStub(new TestGadgetTarget(value)) as unknown as RpcStub<TestGadget>,
  ),
) {
  const getUiBundle = vi.fn<() => Promise<UiBundle | null>>(async () => ({ jsCode: bundleCode }))
  const getLibraryCode = vi.fn<(specifier: string) => Promise<string>>()
  return {
    connectToGadget,
    getUiBundle,
    getLibraryCode,
    stub: { connectToGadget, getUiBundle, getLibraryCode } as unknown as RpcStub<GadgetClient>,
  }
}

// Points `gadget`'s bundle at one library module, `code`, under the hash the host will check it by.
async function serveLibrary(gadget: ReturnType<typeof fakeGadget>, jsCode: string, code: string) {
  const hash = await sha256(code)
  gadget.getUiBundle.mockImplementation(async () => ({
    jsCode, libraries: [{ specifier: 'gadgets:demo/client', hash }],
  }))
  gadget.getLibraryCode.mockImplementation(async () => code)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function dispatchIframeHandshake(iframe: HTMLIFrameElement, port: MessagePort) {
  window.dispatchEvent(new MessageEvent('message', {
    data: 'handshake',
    origin: 'null',
    source: iframe.contentWindow,
    ports: [port],
  }))
}

function importMapOf(srcdoc: string): Record<string, string> {
  const match = /<script type="importmap">(.*?)<\/script>/s.exec(srcdoc)
  if (!match) throw new Error('no import map in srcdoc')
  return JSON.parse(match[1]).imports
}

function bannerText(container: HTMLElement): string {
  return container.querySelector('[data-testid="banner"]')?.textContent ?? ''
}

function decodeDataModule(url: string): string {
  const prefix = 'data:text/javascript;base64,'
  expect(url.startsWith(prefix)).toBe(true)
  const bytes = Uint8Array.from(atob(url.slice(prefix.length)), c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

describe('GadgetUI RPC recovery', () => {
  let container: HTMLDivElement
  let root: Root
  const childSessions: RpcStub<TestGadget>[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const session of childSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
  })

  function connectIframe(iframe: HTMLIFrameElement) {
    const { port1, port2 } = new MessageChannel()
    const child = newMessagePortRpcSession<TestGadget>(port1)
    childSessions.push(child)
    dispatchIframeHandshake(iframe, port2)
    return child
  }

  it('lays out gadget UI against the device-width viewport', async () => {
    const gadget = fakeGadget('responsive', 'document.body.textContent = "responsive"')
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(container.querySelector('iframe')!.srcdoc).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
  })

  it('keeps the iframe while redirecting calls to the replacement gadget client', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const firstChild = connectIframe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('first')
    await expect((firstChild as any).child().read()).resolves.toBe('first')

    const replacement = fakeGadget('replacement', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())
    // The reconnect asks the replacement what it serves, and finding the same bundle keeps the iframe.
    await vi.waitFor(() => expect(replacement.getUiBundle).toHaveBeenCalledOnce())
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('iframe')).toBe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('replacement')
    await expect((firstChild as any).child().read()).resolves.toBe('replacement')
  })

  it('reloads the iframe when the replacement gadget client serves different code', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const firstChild = connectIframe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('first')

    // A collaborator merged new code into the gadget, or a deploy changed the server it runs on,
    // and the socket dropped: the iframe still runs the old client.js.
    const replacement = fakeGadget('replacement', 'document.body.textContent = "merged"')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    // The iframe is unmounted while the new bundle loads, so wait for the new content, not merely
    // for the first iframe to be gone.
    await vi.waitFor(() => expect(container.querySelector('iframe')?.srcdoc).toContain('merged'))
    expect(container.querySelector('iframe')).not.toBe(firstIframe)
    expect(container.querySelector('iframe')!.srcdoc).not.toContain('"first"')
    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(reloadedChild.read()).resolves.toBe('replacement')
  })

  it('reloads the iframe when only a library the code imports changed', async () => {
    const jsCode = 'import { greeting } from "gadgets:demo/client"; document.body.textContent = greeting'
    const first = fakeGadget('first', jsCode)
    await serveLibrary(first, jsCode, 'export const greeting = "reconnect v1"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    expect(decodeDataModule(importMapOf(firstIframe.srcdoc)['gadgets:demo/client'])).toContain('v1')
    connectIframe(firstIframe)

    // A deploy shipped a new `latest` library. The gadget's own code is unchanged, so nothing but
    // the hash in the bundle's refs says so.
    const replacement = fakeGadget('replacement', jsCode)
    await serveLibrary(replacement, jsCode, 'export const greeting = "reconnect v2"')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    await vi.waitFor(() => {
      const iframe = container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(decodeDataModule(importMapOf(iframe!.srcdoc)['gadgets:demo/client'])).toContain('v2')
    })
    expect(container.querySelector('iframe')).not.toBe(firstIframe)
  })

  it('keeps the redirected iframe when the replacement cannot say what bundle it serves', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = fakeGadget('first', 'document.body.textContent = "first"')
      await act(async () => {
        root.render(<GadgetUI gadget={first.stub} height="100px" />)
      })
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const firstIframe = container.querySelector('iframe')!
      const firstChild = connectIframe(firstIframe)
      await expect(firstChild.read()).resolves.toBe('first')

      const replacement = fakeGadget('replacement', 'unused')
      replacement.getUiBundle.mockRejectedValue(new Error('metadata unavailable'))
      await act(async () => {
        root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
      })

      await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalledOnce())
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector('iframe')).toBe(firstIframe)
      await expect(firstChild.read()).resolves.toBe('replacement')
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('queues calls while the replacement connection is pending', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "first"',
      vi.fn(() => connection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())

    const read = child.read()
    const replacementStub = new RpcStub(
      new TestGadgetTarget('replacement'),
    ) as unknown as RpcStub<TestGadget>
    connection.resolve(replacementStub)

    await expect(read).resolves.toBe('replacement')
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it('abandons queued calls when a code reload replaces the iframe', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(connection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const replacement = fakeGadget('replacement', 'unused', connectToGadget)
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={0} />)
    })
    const read = child.read()

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={1} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(iframe))
    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(read).rejects.toBeDefined()
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })

  it('re-subscribes disposed callbacks without restoring an intentional unsubscribe', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    const values: string[] = []
    let callbacks: TestCallbacks | undefined
    let subscription: RpcStub<TestSubscription> | undefined
    let subscribeCount = 0
    const subscribe = async () => {
      callbacks = new TestCallbacks(values, () => void subscribe())
      subscription = await child.subscribe(callbacks) as unknown as RpcStub<TestSubscription>
      subscribeCount++
    }
    await subscribe()
    expect(values).toEqual(['first'])

    const replacement = fakeGadget('replacement', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(values).toEqual(['first', 'replacement']))
    await vi.waitFor(() => expect(replacement.getUiBundle).toHaveBeenCalledOnce())
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('iframe')).toBe(iframe)

    callbacks!.closed = true
    subscription![Symbol.dispose]()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(subscribeCount).toBe(2)
  })

  it('reloads after a replacement timeout and disposes the late capability', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget('replacement', 'unused', vi.fn(() => connection.promise))
    vi.useFakeTimers()
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    expect(replacement.connectToGadget).toHaveBeenCalledOnce()
    const read = child.read()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    vi.useRealTimers()
    await expect(read).rejects.toBeDefined()
    expect(container.querySelector('iframe')).not.toBe(iframe)

    const disposed = vi.fn<() => void>()
    connection.resolve(
      new RpcStub(new TestGadgetTarget('late', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await connection.promise
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
  })

  it('ignores a superseded replacement connection', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const staleConnection = deferred<RpcStub<TestGadget>>()
    const stale = fakeGadget('stale', 'unused', vi.fn(() => staleConnection.promise))
    await act(async () => root.render(<GadgetUI gadget={stale.stub} height="100px" />))
    await vi.waitFor(() => expect(stale.connectToGadget).toHaveBeenCalledOnce())

    const current = fakeGadget('current', 'document.body.textContent = "first"')
    await act(async () => root.render(<GadgetUI gadget={current.stub} height="100px" />))
    await vi.waitFor(() => expect(current.connectToGadget).toHaveBeenCalledOnce())
    await expect(child.read()).resolves.toBe('current')

    const disposed = vi.fn<() => void>()
    staleConnection.resolve(
      new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await staleConnection.promise
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('current')
  })

  it('ignores an old bundle that resolves after the gadget client is replaced', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => {
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  it('ignores an old bundle while its replacement is hidden', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible={false} />)
    })
    expect(replacement.getUiBundle).not.toHaveBeenCalled()

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible />)
    })
    await vi.waitFor(() => {
      expect(replacement.getUiBundle).toHaveBeenCalledOnce()
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  it('disposes a connection that resolves after the gadget client is replaced', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const first = fakeGadget(
      'first',
      'document.body.textContent = "first"',
      vi.fn(() => oldConnection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    dispatchIframeHandshake(firstIframe, new MessageChannel().port2)

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(firstIframe))

    const disposed = vi.fn<() => void>()
    await act(async () => {
      oldConnection.resolve(
        new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
      )
      await oldConnection.promise
    })
    expect(disposed).toHaveBeenCalledOnce()

    const replacementChild = connectIframe(container.querySelector('iframe')!)
    await expect(replacementChild.read()).resolves.toBe('replacement')
  })

  it('ignores a handshake rejection from an iframe that was reloaded', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(oldConnection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const gadget = fakeGadget(
      'initial',
      'document.body.textContent = "bundle"',
      connectToGadget,
    )
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const oldIframe = container.querySelector('iframe')!
    dispatchIframeHandshake(oldIframe, new MessageChannel().port2)

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(oldIframe))

    await act(async () => {
      oldConnection.reject(new Error('old connection lost'))
      await oldConnection.promise.catch(() => {})
    })
    expect(container.querySelector('iframe')).not.toBeNull()

    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })
})

describe('GadgetUI library import map', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  // Non-ASCII on purpose: a library bundle is not btoa()-safe the way the capnweb prefix is. The
  // tag makes each test's module distinct, since the cache is keyed by the module's real hash and
  // lives for the whole test file.
  const libraryCode = (tag: string) => `export const greeting = "héllo — 你好 ${tag}"`

  function libraryGadget(
    tag: string,
    getLibraryCode = vi.fn<(specifier: string) => Promise<string>>(async () => libraryCode(tag)),
  ) {
    const bundle = async (): Promise<UiBundle> => ({
      jsCode: 'import { greeting } from "gadgets:demo/client"; document.body.textContent = greeting',
      libraries: [{ specifier: 'gadgets:demo/client', hash: await sha256(libraryCode(tag)) }],
    })
    return {
      getLibraryCode,
      stub: {
        connectToGadget: async () => new RpcStub(new TestGadgetTarget('library')),
        getUiBundle: bundle,
        getLibraryCode,
      } as unknown as RpcStub<GadgetClient>,
    }
  }

  it('maps each library specifier to its code as a UTF-8 data: module, ahead of the gadget script', async () => {
    const gadget = libraryGadget('utf8')
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" chatId={3} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    const srcdoc = container.querySelector('iframe')!.srcdoc
    expect(srcdoc.indexOf('<script type="importmap">')).toBeLessThan(srcdoc.indexOf('<script type="module"'))
    const imports = importMapOf(srcdoc)
    expect(Object.keys(imports)).toEqual(['gadgets:demo/client'])
    expect(decodeDataModule(imports['gadgets:demo/client'])).toBe(libraryCode('utf8'))
    expect(gadget.getLibraryCode).toHaveBeenCalledWith('gadgets:demo/client', 3)
  })

  it('downloads a library once per hash across gadgets', async () => {
    const first = libraryGadget('shared')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(first.getLibraryCode).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    root = createRoot(container)
    const second = libraryGadget('shared')
    await act(async () => {
      root.render(<GadgetUI gadget={second.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(second.getLibraryCode).not.toHaveBeenCalled()
    expect(decodeDataModule(importMapOf(container.querySelector('iframe')!.srcdoc)['gadgets:demo/client']))
      .toBe(libraryCode('shared'))
  })

  it('refuses code that does not match the hash the bundle named, and does not cache it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tampered = libraryGadget('honest', vi.fn(async () => libraryCode('tampered')))
      await act(async () => {
        root.render(<GadgetUI gadget={tampered.stub} height="100px" />)
      })
      await vi.waitFor(() => expect(bannerText(container)).toContain('Failed to load UI bundle'))
      expect(container.querySelector('iframe')).toBeNull()

      await act(async () => root.unmount())
      root = createRoot(container)
      const honest = libraryGadget('honest')
      await act(async () => {
        root.render(<GadgetUI gadget={honest.stub} height="100px" />)
      })
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      expect(honest.getLibraryCode).toHaveBeenCalledOnce()
      expect(decodeDataModule(importMapOf(container.querySelector('iframe')!.srcdoc)['gadgets:demo/client']))
        .toBe(libraryCode('honest'))
    } finally {
      consoleError.mockRestore()
    }
  })

  it('evicts a failed download so the next gadget retries it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failing = libraryGadget('flaky', vi.fn(async () => { throw new Error('offline') }))
      await act(async () => {
        root.render(<GadgetUI gadget={failing.stub} height="100px" />)
      })
      await vi.waitFor(() => expect(failing.getLibraryCode).toHaveBeenCalledOnce())
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector('iframe')).toBeNull()
      expect(bannerText(container)).toContain('Failed to load UI bundle')

      await act(async () => root.unmount())
      root = createRoot(container)
      const retried = libraryGadget('flaky')
      await act(async () => {
        root.render(<GadgetUI gadget={retried.stub} height="100px" />)
      })
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      expect(retried.getLibraryCode).toHaveBeenCalledOnce()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('evicts a download that never settles, so the hash is not poisoned for the page', async () => {
    const stalled = libraryGadget('stalled', vi.fn(() => new Promise<string>(() => {})))
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(<GadgetUI gadget={stalled.stub} height="100px" />)
      })
      // Under fake timers waitFor advances the clock by its interval per check, far short of the
      // deadline below, so this only waits out the bundle round trip.
      await vi.waitFor(() => expect(stalled.getLibraryCode).toHaveBeenCalledOnce())

      // The reply never comes -- the stub was disposed under the load by a reconnect. The load
      // stops owning the view and offers a retry instead of spinning.
      await act(async () => vi.advanceTimersByTimeAsync(20_000))
      expect(bannerText(container)).toContain('Timed out')
    } finally {
      vi.useRealTimers()
    }

    // The next gadget on the same hash fetches again rather than awaiting the dead promise.
    await act(async () => root.unmount())
    root = createRoot(container)
    const later = libraryGadget('stalled')
    await act(async () => {
      root.render(<GadgetUI gadget={later.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(later.getLibraryCode).toHaveBeenCalledOnce()
    expect(decodeDataModule(importMapOf(container.querySelector('iframe')!.srcdoc)['gadgets:demo/client']))
      .toBe(libraryCode('stalled'))
  })
})
