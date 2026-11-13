// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcPromise, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ConsoleLogEvent,
  type GadgetClient,
  type Overseer,
  type PublicApi,
  type UiBundle,
  MAX_GADGET_ERRORS_PER_CALL,
  MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH,
} from '@gadgets/workshop-shared/api'

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

vi.mock('@cloudflare/kumo', () => ({
  Banner: () => null,
  Loader: () => null,
  Text: ({ children }: { children: ReactNode }) => children,
}))

import ReportingGadgetUI from './GadgetUI'
import { RpcContext } from './RpcContext'
import { GADGET_ERROR_FLUSH_MS, GADGET_ERROR_MAX_BACKOFF_MS } from './features/gadget-errors/gadgetErrorReporter'

type GadgetUIProps = ComponentProps<typeof ReportingGadgetUI>

// The view the suites that do not exercise error reporting render: it has no workspace to report
// to, and a fixed gadget id.
const GadgetUI = (props: Omit<GadgetUIProps, 'overseer' | 'gadgetId'>) =>
  <ReportingGadgetUI overseer={null} gadgetId={1} {...props} />

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

class TestGadgetClientTarget extends RpcTarget {
  constructor(private value: string) {
    super()
  }

  connectToGadget() {
    return new TestGadgetTarget(this.value)
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

function fakeGadget(
  value: string,
  bundleCode: string,
  connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(
    async () => new RpcStub(new TestGadgetTarget(value)) as unknown as RpcStub<TestGadget>,
  ),
) {
  const getUiBundle = vi.fn<() => Promise<UiBundle | null>>(async () => ({ jsCode: bundleCode }))
  return {
    connectToGadget,
    getUiBundle,
    stub: { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient>,
  }
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

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('replacement')
    await expect((firstChild as any).child().read()).resolves.toBe('replacement')
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
      'document.body.textContent = "replacement"',
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

    const replacement = fakeGadget('replacement', 'unused')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(values).toEqual(['first', 'replacement']))
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

  it('keeps the iframe for as long as the replacement gadget client is unresolved', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    // As during an outage: a client pipelined on a connection that has not been made yet.
    const connection = deferred<RpcStub<GadgetClient>>()
    const pending = new RpcPromise<GadgetClient>(connection.promise)
    vi.useFakeTimers()
    await act(async () => {
      root.render(<GadgetUI gadget={pending} height="100px" />)
    })
    const read = child.read()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    vi.useRealTimers()
    expect(container.querySelector('iframe')).toBe(iframe)

    connection.resolve(
      new RpcStub(new TestGadgetClientTarget('restored')) as unknown as RpcStub<GadgetClient>,
    )
    await expect(read).resolves.toBe('restored')
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it('connects a replacement gadget client after a handshake on a failed one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = fakeGadget(
      'failed',
      'document.body.textContent = "bundle"',
      vi.fn(async () => { throw new Error('workspace failed to reopen') }),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={failed.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    dispatchIframeHandshake(container.querySelector('iframe')!, new MessageChannel().port2)
    await vi.waitFor(() => expect(container.querySelector('iframe')).toBeNull())
    consoleError.mockRestore()

    const replacement = fakeGadget('replacement', 'unused')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    const child = connectIframe(container.querySelector('iframe')!)
    await expect(child.read()).resolves.toBe('replacement')
    expect(replacement.getUiBundle).not.toHaveBeenCalled()
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

    const current = fakeGadget('current', 'unused')
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

// GadgetEditor auto-switches to the code tab only while this reports true, so a gadget whose UI
// is merely reloading must never report it.
describe('GadgetUI no-UI placeholder reporting', () => {
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

  it('reports the placeholder only once a load confirms there is no UI, and retracts it', async () => {
    const gadget = fakeGadget('draft', 'document.body.textContent = "ui"')
    const noUi = deferred<UiBundle | null>()
    gadget.getUiBundle.mockReturnValueOnce(noUi.promise)
    const onNoUiChange = vi.fn<(showsNoUi: boolean) => void>()
    const render = (reloadTrigger: number) => root.render(
      <GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={reloadTrigger}
        onNoUiChange={onNoUiChange} />,
    )

    await act(async () => render(0))
    expect(onNoUiChange).not.toHaveBeenCalled()

    await act(async () => {
      noUi.resolve(null)
      await noUi.promise
    })
    await vi.waitFor(() => expect(onNoUiChange).toHaveBeenLastCalledWith(true))

    await act(async () => render(1))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(onNoUiChange).toHaveBeenLastCalledWith(false)
  })

  it('retracts the placeholder as soon as a reload starts', async () => {
    const gadget = fakeGadget('draft', 'document.body.textContent = "ui"')
    gadget.getUiBundle.mockResolvedValueOnce(null)
    const onNoUiChange = vi.fn<(showsNoUi: boolean) => void>()
    const render = (reloadTrigger: number) => root.render(
      <GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={reloadTrigger}
        onNoUiChange={onNoUiChange} />,
    )

    await act(async () => render(0))
    await vi.waitFor(() => expect(onNoUiChange).toHaveBeenLastCalledWith(true))

    const reload = deferred<UiBundle | null>()
    gadget.getUiBundle.mockReturnValueOnce(reload.promise)
    await act(async () => render(1))
    expect(onNoUiChange).toHaveBeenLastCalledWith(false)

    await act(async () => {
      reload.resolve({ jsCode: 'document.body.textContent = "ui v2"' })
      await reload.promise
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(onNoUiChange).toHaveBeenLastCalledWith(false)
  })

  it('never reports the placeholder while an existing UI reloads', async () => {
    const gadget = fakeGadget('live', 'document.body.textContent = "ui"')
    const reload = deferred<UiBundle | null>()
    const onNoUiChange = vi.fn<(showsNoUi: boolean) => void>()
    const render = (reloadTrigger: number) => root.render(
      <GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={reloadTrigger}
        onNoUiChange={onNoUiChange} />,
    )

    await act(async () => render(0))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    gadget.getUiBundle.mockReturnValueOnce(reload.promise)
    await act(async () => render(1))
    await act(async () => {
      reload.resolve({ jsCode: 'document.body.textContent = "ui v2"' })
      await reload.promise
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')?.srcdoc).toContain('v2'))
    expect(onNoUiChange).not.toHaveBeenCalled()
  })
})

/**
 * An array of `length` holes, as a frame can post one in a few bytes. Its length is assigned because
 * Array.from({ length }), which the lint suggests in place of `new Array(length)`, builds every
 * element: 2^32 - 1 of them cannot be built.
 */
function sparseArray(length: number): unknown[] {
  const holes: unknown[] = []
  holes.length = length
  return holes
}

/** Posts `data` to the page as a message from `iframe`'s document, or from where `from` says. */
function postFromFrame(
  iframe: HTMLIFrameElement,
  data: unknown,
  from: { origin?: string; source?: MessageEventSource | null } = {},
) {
  window.dispatchEvent(new MessageEvent('message', {
    data, origin: 'null', source: iframe.contentWindow, ...from,
  }))
}

describe('GadgetUI error reporting', () => {
  const GADGET_ID = 7
  const STACK = 'Error: thrown\n    at render (client.js:3:9)'
  // What the frame's "error" listener posts, and the entry the Workshop reports for it.
  const UNCAUGHT = { type: 'console', level: 'error', message: ['Uncaught', STACK], uncaught: true }
  const UNCAUGHT_ENTRY = { text: `Uncaught ${STACK}` }
  // The `i`th error of a frame that throws in a loop.
  const thrown = (i: number) => ({ ...UNCAUGHT, message: ['Uncaught', `Error: loop ${i}`] })
  const SEND_FAILURE = 'Failed to report gadget errors:'

  const reportGadgetErrors = vi.fn<Overseer['reportGadgetErrors']>(async () => {})
  const overseer = { reportGadgetErrors } as unknown as RpcStub<Overseer>

  let container: HTMLDivElement
  let root: Root
  let gadget: RpcStub<GadgetClient>

  beforeEach(() => {
    reportGadgetErrors.mockReset().mockImplementation(async () => {})
    gadget = fakeGadget('errors', 'document.body.textContent = "errors"').stub
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    container.remove()
  })

  // A view with a workspace to report to.
  const view = (props: Partial<GadgetUIProps> = {}) => (
    <ReportingGadgetUI gadget={gadget} overseer={overseer} gadgetId={GADGET_ID} height="100px" {...props} />
  )

  const withConnection = (connectionLost: boolean, props: Partial<GadgetUIProps> = {}) => (
    <RpcContext.Provider value={{ stub: {} as RpcStub<PublicApi>, connectionLost }}>
      {view(props)}
    </RpcContext.Provider>
  )

  // The frame loads under the real clock, which is faked once it is there, for the reporter's
  // timers.
  const mount = async (ui: ReactNode) => {
    await act(async () => root.render(ui))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    vi.useFakeTimers()
    return container.querySelector('iframe')!
  }

  it('reports no console call, at any level, and still shows each in the live console', async () => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    const levels = ['debug', 'info', 'log', 'warn', 'error'] as const
    for (const level of levels) postFromFrame(iframe, { type: 'console', level, message: ['said', level] })

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()
    expect(onConsoleLog.mock.calls.map(([log]) => log)).toStrictEqual(
      levels.map(level => ({ timestamp: expect.any(Date), level, message: ['said', level] })))

    // Nothing was queued either: the view makes no call as it goes away.
    await act(async () => root.unmount())
    expect(reportGadgetErrors).not.toHaveBeenCalled()
  })

  it('reports an uncaught error, with no chat selected and nobody listening', async () => {
    const iframe = await mount(view())
    postFromFrame(iframe, UNCAUGHT)
    expect(reportGadgetErrors).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    // Strictly: the entry is its text alone, with no time of the browser's.
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
  })

  it('reports an unhandled rejection', async () => {
    const iframe = await mount(view())
    postFromFrame(iframe, {
      type: 'console',
      level: 'error',
      message: ['Unhandled promise rejection:', 'Error: rejected\n    at load (client.js:8:3)'],
      uncaught: true,
    })

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([
      GADGET_ID, null, [{ text: 'Unhandled promise rejection: Error: rejected\n    at load (client.js:8:3)' }],
    ])
  })

  it('reports under the chat whose draft the view shows', async () => {
    const iframe = await mount(view({ chatId: 3 }))
    postFromFrame(iframe, UNCAUGHT)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, 3, [UNCAUGHT_ENTRY]])
  })

  it('still shows an uncaught error in the live console, as it was posted', async () => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    postFromFrame(iframe, UNCAUGHT)

    expect(onConsoleLog).toHaveBeenCalledTimes(1)
    expect(onConsoleLog.mock.calls[0]).toStrictEqual([
      { timestamp: expect.any(Date), level: 'error', message: ['Uncaught', STACK] },
    ])
  })

  it.each(['yes', 1, 'true', {}])('reports no message whose marker is %j: only true marks one', async uncaught => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    postFromFrame(iframe, { ...UNCAUGHT, uncaught })

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()
    expect(onConsoleLog).toHaveBeenCalledTimes(1)
  })

  it('ignores a marked message that is not from its own frame', async () => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    postFromFrame(iframe, UNCAUGHT, { source: window })
    postFromFrame(iframe, UNCAUGHT, { origin: 'https://gadgets.example' })

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()
    expect(onConsoleLog).not.toHaveBeenCalled()
  })

  // No timing is asserted. A reporter that visited every index of the posted array would not
  // finish inside the test timeout.
  it('handles a marked message built to stall the page like any other', async () => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    const message = sparseArray(2 ** 32 - 1)
    postFromFrame(iframe, { type: 'console', level: 'error', message, uncaught: true })

    // The live console is handed the message as posted, as for any console message.
    expect(onConsoleLog).toHaveBeenCalledTimes(1)
    expect(onConsoleLog.mock.calls[0][0].message).toBe(message)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    const [, , entries] = reportGadgetErrors.mock.calls[0]
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toHaveLength(MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH)
    expect(entries[0].text.startsWith('undefined undefined')).toBe(true)
  })

  it('reports the first errors of a frame in a throw loop and shows them all', async () => {
    const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
    const iframe = await mount(view({ onConsoleLog }))
    for (let i = 0; i < MAX_GADGET_ERRORS_PER_CALL; i++) postFromFrame(iframe, thrown(i))
    for (let i = 0; i < 1_000; i++) postFromFrame(iframe, thrown(MAX_GADGET_ERRORS_PER_CALL + i))
    expect(onConsoleLog).toHaveBeenCalledTimes(MAX_GADGET_ERRORS_PER_CALL + 1_000)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([
      GADGET_ID, null,
      Array.from({ length: MAX_GADGET_ERRORS_PER_CALL }, (_, i) => ({ text: `Uncaught Error: loop ${i}` })),
    ])

    // The thousand after them added nothing to send.
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
  })

  it('sends what is queued when the view goes away', async () => {
    const iframe = await mount(view())
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.unmount())
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
  })

  // The order the editor's workspace hook and a view are cleaned up in when both go away: the hook
  // disposes the workspace's stub in a passive effect's cleanup, as `Workspace` does here. A view
  // that stopped its reporter in a passive cleanup too would run after its parent's, and send its
  // last errors through a disposed stub.
  it('sends its last errors before the workspace is let go', async () => {
    const order: string[] = []
    reportGadgetErrors.mockImplementation(async () => {
      order.push('report')
    })
    const Workspace = ({ children }: { children: ReactNode }) => {
      useEffect(() => () => {
        order.push('dispose')
      }, [])
      return children
    }
    const iframe = await mount(<Workspace>{view()}</Workspace>)
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.unmount())
    expect(order).toStrictEqual(['report', 'dispose'])
  })

  it('sends at once when the page is hidden, and not when it is shown', async () => {
    const iframe = await mount(view())
    postFromFrame(iframe, UNCAUGHT)

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reportGadgetErrors).not.toHaveBeenCalled()

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
  })

  // A view whose frame is kept while another tab is on screen reports all the same: the reporter
  // looks at no tab and no selected chat.
  it('reports from a view that is no longer visible', async () => {
    const iframe = await mount(view())
    await act(async () => root.render(view({ isVisible: false })))
    expect(container.querySelector('iframe')).toBe(iframe)
    postFromFrame(iframe, UNCAUGHT)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
  })

  // A null stub is a workspace with no connection at all: one that has not opened, or failed to.
  // It is not what an outage looks like, which the next case covers.
  it('holds an error back while its workspace has no connection, and sends it once it has one', async () => {
    const iframe = await mount(view({ overseer: null }))
    postFromFrame(iframe, UNCAUGHT)
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()

    await act(async () => root.render(view()))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
  })

  // The stub being there must not decide. Through an outage the view holds a stub that waits for
  // the connection being made, on which a send would be delivered late, after the reporter had
  // given it up.
  it('holds an error back while the connection is lost, though it has a stub', async () => {
    const iframe = await mount(withConnection(true))
    postFromFrame(iframe, UNCAUGHT)
    await vi.advanceTimersByTimeAsync(6 * GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()

    await act(async () => root.render(withConnection(false)))
    expect(container.querySelector('iframe')).toBe(iframe)
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    expect(reportGadgetErrors.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
  })

  it('sends its queue through the stub that replaced the one it was queued under', async () => {
    const replacement = vi.fn<Overseer['reportGadgetErrors']>(async () => {})
    const iframe = await mount(view())
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.render(view({
      overseer: { reportGadgetErrors: replacement } as unknown as RpcStub<Overseer>,
    })))
    expect(container.querySelector('iframe')).toBe(iframe)
    // The queue waits out its interval. A reporter that was stopped and made again for the next
    // stub would send it here, at the replacement.
    expect(replacement).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(replacement.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
    expect(reportGadgetErrors).not.toHaveBeenCalled()
  })

  // What an outage does to a mounted view: its workspace's stub is replaced while the connection
  // is lost. A reporter that was stopped there would have nothing to send its queue through, and
  // would discard it.
  it('keeps its queue when its stub is replaced while the connection is lost', async () => {
    const replacement = vi.fn<Overseer['reportGadgetErrors']>(async () => {})
    const replaced = { overseer: { reportGadgetErrors: replacement } as unknown as RpcStub<Overseer> }
    const iframe = await mount(withConnection(false))
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.render(withConnection(true, replaced)))
    expect(container.querySelector('iframe')).toBe(iframe)
    await vi.advanceTimersByTimeAsync(2 * GADGET_ERROR_FLUSH_MS)
    expect(replacement).not.toHaveBeenCalled()

    await act(async () => root.render(withConnection(false, replaced)))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(replacement.mock.calls[0]).toStrictEqual([GADGET_ID, null, [UNCAUGHT_ENTRY]])
    expect(reportGadgetErrors).not.toHaveBeenCalled()
  })

  // The error is lost, which the hook's comment states.
  it.each<{ way: string; ui: () => ReactNode }>([
    { way: 'its workspace has no connection', ui: () => view({ overseer: null }) },
    { way: 'the connection is lost', ui: () => withConnection(true) },
  ])('sends nothing when it goes away while $way', async ({ ui }) => {
    const iframe = await mount(ui())
    const timers = vi.getTimerCount()
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).not.toHaveBeenCalled()
  })

  // What a view meets when its workspace's stub was disposed a commit before it unmounts. The
  // errors are lost, which the hook's comment states. A second call here would be the first of
  // one every interval for as long as the tab lives.
  it('does not send again after its last batch is refused', async () => {
    reportGadgetErrors.mockImplementation(
      () => Promise.reject(new Error('Attempted to use RPC stub after it has been disposed')))
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const iframe = await mount(view())
    const timers = vi.getTimerCount()
    postFromFrame(iframe, UNCAUGHT)

    await act(async () => root.unmount())
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(reportGadgetErrors).toHaveBeenCalledTimes(1)
    // The failure is logged once, and what is logged is the RPC's error, never the queued text.
    const logged = [...debug.mock.calls, ...error.mock.calls].filter(call => call[0] === SEND_FAILURE)
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged.map(call => String(call[1])))).not.toContain('thrown')
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
  })
})
