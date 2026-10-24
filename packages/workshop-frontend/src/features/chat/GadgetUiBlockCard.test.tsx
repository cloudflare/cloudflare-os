// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { GadgetUiBlock } from '@gadgets/workshop-shared/gadget-ui-blocks'
import { createUiBlockDocumentStart, readUiBlockTheme, type UiBlockFrame, type UiBlockHost } from './uiBlockFrame'

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
  Banner: Object.assign(
    ({ description, action }: { description: ReactNode; action?: ReactNode }) => <div>{description}{action}</div>,
    { Action: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button> },
  ),
  Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
  Input: () => null,
  InputArea: () => null,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))

import { GadgetUiBlockCard, type GadgetUiBlockCardProps } from './GadgetUiBlockCard'

// Every card is near the viewport.
class VisibleIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
  }
  disconnect() {}
}

// Real dates, so each break counts as soon after the handshake; fake timers skip the reload waits.
async function withFakeTimers(test: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await test()
  } finally {
    vi.useRealTimers()
  }
}

// Lets port messages arrive without moving the fake clock, as vi.waitFor would: each turn waits
// for a message on a port of its own, a task the fake timers leave alone.
const nextTask = () => new Promise<void>(resolve => {
  const { port1, port2 } = new MessageChannel()
  port1.addEventListener('message', () => {
    port1.close()
    resolve()
  }, { once: true })
  port1.start()
  port2.postMessage(null)
})
const settle = () => act(async () => {
  for (let turn = 0; turn < 10; turn++) await nextTask()
})

class FakeGadget extends RpcTarget {
  disposed = false
  read() { return 'gadget data' }
  [Symbol.dispose]() { this.disposed = true }
}

class FakeSession extends RpcTarget {
  disposed = false
  listIssues() { return ['#12'] }
  [Symbol.dispose]() { this.disposed = true }
}

// GITHUB is a connection, MODEL a binding a view may not use, and every other name a gadget. A
// lookup for SLOW waits for finishSlow().
class FakeOverseer extends RpcTarget {
  lookups: unknown[][] = []
  served: (FakeGadget | FakeSession)[] = []
  // The server end of each binding, which a test closes to restart that server.
  servers: MessagePort[] = []
  finishSlow = () => {}

  async connectToChatBinding(chatId: number, name: string) {
    this.lookups.push([chatId, name])
    if (name === 'MODEL') throw new Error(`"MODEL" can't be used in a view.`)
    if (name === 'SLOW') await new Promise<void>(resolve => { this.finishSlow = resolve })
    if (name === 'GITHUB') return { type: 'connection', session: this.#serve(new FakeSession()) }
    return { type: 'gadget', rpc: this.#serve(new FakeGadget()) }
  }

  #serve<T extends FakeGadget | FakeSession>(target: T) {
    this.served.push(target)
    const { port1, port2 } = new MessageChannel()
    newMessagePortRpcSession(port1, target)
    this.servers.push(port1)
    return newMessagePortRpcSession<T>(port2)
  }

  restart(server: number) {
    // Cap'n Web's signal that the peer closed the port.
    this.servers[server]?.postMessage(null)
  }
}

// The block's document as the frame gets it, in order: each write, then 'close' once it ends.
class FakeFrame extends RpcTarget implements UiBlockFrame {
  received: string[] = []
  setTheme() {}
  write(html: string) { this.received.push(html) }
  close() { this.received.push('close') }
}

// The host as the block's frame sees it. A name that is not a string is what block code can send.
type TestHost = Omit<UiBlockHost, 'binding'> & {
  binding(name: string | number): Promise<{ rpc: FakeGadget } & FakeSession>
}

type CardBlock = GadgetUiBlockCardProps['block']

const BLOCK: GadgetUiBlock = { kind: 'block', html: '<p>hi</p>', title: 'Spending' }
const open = (html: string): CardBlock => ({ kind: 'open', text: `<gadget-ui>\n${html}`, html })

describe('GadgetUiBlockCard', () => {
  let container: HTMLDivElement
  let root: Root
  let overseer: FakeOverseer
  let sent: string[]
  // What a Send waits on, so a test can hold one in flight or fail it.
  let reply: () => Promise<void>
  const frameSessions: RpcStub<TestHost>[] = []

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    overseer = new FakeOverseer()
    sent = []
    reply = () => Promise.resolve()
  })

  afterEach(async () => {
    for (const session of frameSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const scrollRoot = { current: null }
  const onHeightChange = () => {}
  // One stub for each fake, so rendering again with the same fake keeps the same connection.
  const stubs = new WeakMap<FakeOverseer, RpcStub<Overseer>>()
  const stubOf = (fake: FakeOverseer) => {
    let stub = stubs.get(fake)
    if (!stub) stubs.set(fake, stub = new RpcStub(fake) as unknown as RpcStub<Overseer>)
    return stub
  }
  type CardOptions = { sendBlockedReason?: string; streaming?: boolean }
  const card = (fake: FakeOverseer, block: CardBlock, { sendBlockedReason, streaming = false }: CardOptions = {}) => (
    <GadgetUiBlockCard overseer={stubOf(fake)} chatId={1}
      block={block} streaming={streaming} scrollRoot={scrollRoot} sendBlockedReason={sendBlockedReason}
      onHeightChange={onHeightChange} onSendMessage={message => { sent.push(message); return reply() }} />
  )

  async function renderCard(block: CardBlock = BLOCK, options?: CardOptions) {
    await act(async () => root.render(card(overseer, block, options)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    return container.querySelector('iframe')!
  }

  // Plays the frame's side of the handshake, as the block document's bootstrap does. The host's
  // calls queue on the port until the card answers.
  async function handshake(iframe: HTMLIFrameElement, frame = new FakeFrame()) {
    const { port1, port2 } = new MessageChannel()
    const host = newMessagePortRpcSession<TestHost>(port1, frame)
    frameSessions.push(host)
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake', origin: 'null', source: iframe.contentWindow, ports: [port2],
      }))
    })
    return host
  }

  const buttonNamed = (name: string) =>
    [...container.querySelectorAll('button')].find(button => button.textContent === name)

  it("sends the view's message as the viewer's only when they click Send", async () => {
    const host = await handshake(await renderCard())
    for (let i = 0; i < 5; i++) await host.requestMessage(`Show me week ${i}.`)

    await vi.waitFor(() => expect(container.textContent).toContain('Show me week 4.'))
    expect(container.textContent).not.toContain('Show me week 3.')
    expect(sent).toEqual([])

    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(sent).toEqual(['Show me week 4.']))
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeUndefined())
    // A view that never reads `env` never reaches the kernel.
    expect(overseer.lookups).toEqual([])
  })

  it('drops a message the viewer dismisses', async () => {
    const host = await handshake(await renderCard())
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Dismiss')).toBeDefined())

    await act(async () => buttonNamed('Dismiss')!.click())
    expect(buttonNamed('Send')).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('holds Send while the chat waits on the viewer', async () => {
    const host = await handshake(await renderCard(BLOCK, { sendBlockedReason: 'Approve the pending action above.' }))
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())

    expect(container.textContent).toContain('Approve the pending action above.')
    expect(buttonNamed('Send')!.disabled).toBe(true)
  })

  it('keeps the message for another try when a Send fails', async () => {
    const host = await handshake(await renderCard())
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())
    reply = () => Promise.reject(new Error('offline'))

    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(buttonNamed('Send')!.disabled).toBe(false))
    expect(sent).toEqual(['Pick Aero.'])
    expect(container.textContent).toContain('Pick Aero.')
  })

  it('keeps a newer message when an earlier Send finishes', async () => {
    const host = await handshake(await renderCard())
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())
    let finish = () => {}
    reply = () => new Promise(resolve => { finish = resolve })
    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    await host.requestMessage('Pick Bolt.')
    await vi.waitFor(() => expect(container.textContent).toContain('Pick Bolt.'))
    await act(async () => {
      finish()
      await new Promise(resolve => setTimeout(resolve))
    })
    expect(container.textContent).toContain('Pick Bolt.')
    expect(buttonNamed('Send')).toBeDefined()
  })

  it("gives the view a gadget's server and a connection's session, each opened once", async () => {
    const host = await handshake(await renderCard())
    await expect(host.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
    await expect(host.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
    await expect(host.binding('GITHUB').listIssues()).resolves.toEqual(['#12'])

    expect(overseer.lookups).toEqual([[1, 'EXPENSES'], [1, 'GITHUB']])
    await vi.waitFor(() => expect(container.textContent).toContain('EXPENSES, GITHUB'))
  })

  it('rejects a lookup that fails, and the view keeps running', async () => {
    const host = await handshake(await renderCard())
    await expect(host.binding('MODEL')).rejects.toThrow(`"MODEL" can't be used in a view.`)
    await expect(host.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')

    // The line under the view names only what the view could open.
    await vi.waitFor(() => expect(container.textContent).toContain('EXPENSES'))
    expect(container.textContent).not.toContain('MODEL')
    expect(buttonNamed('Reload')).toBeUndefined()
  })

  it('loads a view again once its answer is stored, if a lookup failed while the answer streamed', async () => {
    const first = await renderCard(BLOCK, { streaming: true })
    await expect((await handshake(first)).binding('MODEL')).rejects.toThrow(`"MODEL" can't be used in a view.`)
    expect(container.querySelector('iframe')).toBe(first)

    await act(async () => root.render(card(overseer, BLOCK)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(first))

    // A lookup that fails in a stored answer has no later tool call to wait for.
    const second = container.querySelector('iframe')!
    await expect((await handshake(second)).binding('MODEL')).rejects.toThrow(`"MODEL" can't be used in a view.`)
    await settle()
    expect(container.querySelector('iframe')).toBe(second)
    expect(overseer.lookups).toEqual([[1, 'MODEL'], [1, 'MODEL']])
  })

  it('refuses a name that is not a string, and a 33rd name', async () => {
    const host = await handshake(await renderCard())
    await expect(host.binding(42)).rejects.toThrow('A binding name is a string.')
    for (let i = 0; i < 32; i++) await host.binding(`G${i}`).rpc.read()

    await expect(host.binding('G32')).rejects.toThrow('at most 32 bindings')
    await expect(host.binding('G0').rpc.read()).resolves.toBe('gadget data')
    expect(overseer.lookups).toHaveLength(32)
  })

  it('disposes a binding that arrives after the view unmounted', async () => {
    const host = await handshake(await renderCard())
    host.binding('SLOW').catch(() => {})
    await vi.waitFor(() => expect(overseer.lookups).toEqual([[1, 'SLOW']]))

    await act(async () => root.render(<></>))
    overseer.finishSlow()
    await vi.waitFor(() => expect(overseer.served[0]?.disposed).toBe(true))
  })

  it("reloads a view each time a binding's server restarts, however often", () => withFakeTimers(async () => {
    let iframe = await renderCard()
    for (let restart = 0; restart < 5; restart++) {
      await (await handshake(iframe)).binding('EXPENSES').rpc.read()
      overseer.restart(restart)
      await vi.waitFor(() => {
        vi.runOnlyPendingTimers()
        expect(container.querySelector('iframe')).not.toBe(iframe)
      })
      iframe = container.querySelector('iframe')!
    }
    await expect((await handshake(iframe)).binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
    expect(overseer.lookups).toHaveLength(6)
    expect(buttonNamed('Reload')).toBeUndefined()
  }))

  it('counts bindings that break together as one restart', () => withFakeTimers(async () => {
    const first = await renderCard()
    const host = await handshake(first)
    await host.binding('EXPENSES').rpc.read()
    await host.binding('GITHUB').listIssues()
    overseer.restart(0)
    overseer.restart(1)
    await settle()
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { vi.advanceTimersByTime(0) })
    expect(container.querySelector('iframe')).not.toBe(first)

    // The next quick restart waits 1 second, as after a single break, not 2.
    const second = container.querySelector('iframe')!
    await (await handshake(second)).binding('EXPENSES').rpc.read()
    overseer.restart(2)
    await settle()
    await act(async () => { vi.advanceTimersByTime(999) })
    expect(container.querySelector('iframe')).toBe(second)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.querySelector('iframe')).not.toBe(second)
  }))

  it('stops a view whose document loaded again', async () => {
    const iframe = await renderCard()
    await (await handshake(iframe)).binding('EXPENSES').rpc.read()
    const { port2 } = new MessageChannel()
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake', origin: 'null', source: iframe.contentWindow, ports: [port2],
      }))
    })

    await vi.waitFor(() => expect(container.textContent).toContain('reloaded itself'))
    await vi.waitFor(() => expect(overseer.served[0]!.disposed).toBe(true))
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeDefined()
  })

  it('reloads a view that asked for a binding on a new connection to the Workshop', async () => {
    const first = await renderCard()
    await (await handshake(first)).binding('EXPENSES').rpc.read()
    const reconnected = new FakeOverseer()
    await act(async () => root.render(card(reconnected, BLOCK)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(first))

    const host = await handshake(container.querySelector('iframe')!)
    await expect(host.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
    expect(reconnected.lookups).toEqual([[1, 'EXPENSES']])
    await vi.waitFor(() => expect(overseer.served[0]!.disposed).toBe(true))
  })

  it('reloads a view whose lookup is in flight when the Workshop reconnects', async () => {
    const first = await renderCard()
    ;(await handshake(first)).binding('SLOW').catch(() => {})
    await vi.waitFor(() => expect(overseer.lookups).toEqual([[1, 'SLOW']]))

    await act(async () => root.render(card(new FakeOverseer(), BLOCK)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(first))
  })

  it('keeps a view that never asked for a binding running, and looks up on the new connection', async () => {
    const first = await renderCard()
    const host = await handshake(first)
    const reconnected = new FakeOverseer()
    await act(async () => root.render(card(reconnected, BLOCK)))

    expect(container.querySelector('iframe')).toBe(first)
    await expect(host.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
    expect(reconnected.lookups).toEqual([[1, 'EXPENSES']])
    expect(overseer.lookups).toEqual([])
  })

  it('disposes every binding when it unmounts', async () => {
    const host = await handshake(await renderCard())
    await host.binding('EXPENSES').rpc.read()
    await host.binding('GITHUB').listIssues()
    await act(async () => root.render(<></>))
    await vi.waitFor(() => expect(overseer.served.map(target => target.disposed)).toEqual([true, true]))
  })

  it('disposes every binding when the viewer stops the view, and runs it again on Run', async () => {
    const host = await handshake(await renderCard())
    await host.binding('EXPENSES').rpc.read()
    await act(async () => buttonNamed('Stop')!.click())
    expect(container.querySelector('iframe')).toBeNull()
    await vi.waitFor(() => expect(overseer.served[0]!.disposed).toBe(true))

    await act(async () => buttonNamed('Run')!.click())
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const again = await handshake(container.querySelector('iframe')!)
    await expect(again.binding('EXPENSES').rpc.read()).resolves.toBe('gadget data')
  })

  it('runs nothing for a block that must not run', async () => {
    await act(async () => root.render(card(overseer, { ...BLOCK, error: 'This view has no content.' })))
    expect(container.textContent).toContain('This view has no content.')
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeUndefined()
  })

  it('gives a stored block\'s frame the start of the document, all of the block, then the end', async () => {
    const frame = new FakeFrame()
    await handshake(await renderCard(), frame)
    await vi.waitFor(() => expect(frame.received).toEqual([createUiBlockDocumentStart(readUiBlockTheme()), BLOCK.html, 'close']))
  })

  it('writes an open block into its frame as it streams, and ends the document once it closes', async () => {
    const iframe = await renderCard(open('<p>Fo'), { streaming: true })
    const frame = new FakeFrame()
    await handshake(iframe, frame)
    expect(container.textContent).toContain('Drawing…')

    await act(async () => root.render(card(overseer, open('<p>Food'), { streaming: true })))
    await act(async () => root.render(card(overseer, { kind: 'block', html: '<p>Food</p>' }, { streaming: true })))
    await vi.waitFor(() => expect(frame.received)
      .toEqual([createUiBlockDocumentStart(readUiBlockTheme()), '<p>Fo', 'od', '</p>', 'close']))
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.textContent).toContain('Live view')
  })

  it('gives a new frame load the start of the document, then all of the block so far', async () => {
    await handshake(await renderCard(open('<p>Fo'), { streaming: true }))
    await act(async () => buttonNamed('Stop')!.click())
    await act(async () => root.render(card(overseer, open('<p>Food'), { streaming: true })))
    await act(async () => buttonNamed('Run')!.click())
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    const frame = new FakeFrame()
    await handshake(container.querySelector('iframe')!, frame)
    await vi.waitFor(() => expect(frame.received).toEqual([createUiBlockDocumentStart(readUiBlockTheme()), '<p>Food']))
  })

  it('stops an open block that closes with nothing but a title', async () => {
    await handshake(await renderCard(open('<title>Plan</title>'), { streaming: true }))
    await act(async () => root.render(card(overseer,
      { kind: 'block', html: '<title>Plan</title>', title: 'Plan', error: 'This view has no content.' }, { streaming: true })))
    expect(container.textContent).toContain('This view has no content.')
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeUndefined()
  })
})
