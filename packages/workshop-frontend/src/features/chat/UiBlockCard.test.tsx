// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, ViewBinding } from '@gadgets/workshop-shared/api'
import type { InlineHtmlBlock } from '@gadgets/workshop-shared/inline-html-blocks'
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

import { UiBlockCard, type UiBlockCardProps } from './UiBlockCard'

// Every card is near the viewport.
class VisibleIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
  }
  disconnect() {}
}

// The block's document as the frame gets it, in order: each write, then 'close' once it ends.
class FakeFrame extends RpcTarget implements UiBlockFrame {
  received: string[] = []
  disposed = false
  // What the bootstrap's Trusted Types probe found.
  constructor(private enforced: boolean | 'throws' = true) { super() }
  setTheme() {}
  trustedTypes() {
    if (this.enforced === 'throws') throw new Error('no trustedTypes')
    return this.enforced
  }
  write(html: string) { this.received.push(html) }
  close() { this.received.push('close') }
  [Symbol.dispose]() { this.disposed = true }
}

type CardBlock = UiBlockCardProps['block']

const BLOCK: InlineHtmlBlock = { kind: 'block', html: '<p>hi</p>', title: 'Spending' }
const open = (html: string): CardBlock => ({ kind: 'open', text: `<inline-html>\n${html}`, html })

describe('UiBlockCard', () => {
  let container: HTMLDivElement
  let root: Root
  let sent: string[]
  // What a Send waits on, so a test can hold one in flight or fail it.
  let reply: () => Promise<void>
  const frameSessions: RpcStub<UiBlockHost>[] = []

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
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
  const card = (block: CardBlock, sendBlockedReason?: string) => (
    <UiBlockCard block={block} scrollRoot={scrollRoot} sendBlockedReason={sendBlockedReason}
      onHeightChange={onHeightChange} onSendMessage={message => { sent.push(message); return reply() }} />
  )

  async function renderCard(block: CardBlock = BLOCK, sendBlockedReason?: string) {
    await act(async () => root.render(card(block, sendBlockedReason)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    return container.querySelector('iframe')!
  }

  // Plays the frame's side of the handshake, as the block document's bootstrap does. The host's
  // calls queue on the port until the card answers.
  async function handshake(iframe: HTMLIFrameElement, frame = new FakeFrame()) {
    const { port1, port2 } = new MessageChannel()
    const host = newMessagePortRpcSession<UiBlockHost>(port1, frame)
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
    const host = await handshake(await renderCard(BLOCK, 'Approve the pending action above.'))
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
    const held = Promise.withResolvers<void>()
    reply = () => held.promise
    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    await host.requestMessage('Pick Bolt.')
    await vi.waitFor(() => expect(container.textContent).toContain('Pick Bolt.'))
    // The card awaited the Send first, so its update runs before this await returns.
    await act(async () => {
      held.resolve()
      await held.promise
    })
    expect(container.textContent).toContain('Pick Bolt.')
    expect(buttonNamed('Send')).toBeDefined()
  })

  it('gives a view whose document loaded again the whole block in a new session', async () => {
    const iframe = await renderCard()
    const host = await handshake(iframe)
    await act(async () => { await host.requestMessage('Pick Bolt.') })
    expect(container.textContent).toContain('Pick Bolt.')

    // The view's own code reloaded its document, which handshakes again.
    const reloaded = new FakeFrame()
    await handshake(iframe, reloaded)
    await vi.waitFor(() => expect(reloaded.received).toEqual([createUiBlockDocumentStart(readUiBlockTheme()), BLOCK.html, 'close']))
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.textContent).not.toContain('Pick Bolt.')
  })

  it('runs nothing for a block that must not run', async () => {
    await act(async () => root.render(card({ ...BLOCK, error: 'This view has no content.' })))
    expect(container.textContent).toContain('This view has no content.')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('gives a stored block\'s frame the start of the document, all of the block, then the end', async () => {
    const frame = new FakeFrame()
    await handshake(await renderCard(), frame)
    await vi.waitFor(() => expect(frame.received).toEqual([createUiBlockDocumentStart(readUiBlockTheme()), BLOCK.html, 'close']))
  })

  it('writes an open block into its frame as it streams, and ends the document once it closes', async () => {
    const iframe = await renderCard(open('<p>Fo'))
    const frame = new FakeFrame()
    await handshake(iframe, frame)
    expect(container.textContent).toContain('Drawing…')

    await act(async () => root.render(card(open('<p>Food'))))
    await act(async () => root.render(card({ kind: 'block', html: '<p>Food</p>' })))
    await vi.waitFor(() => expect(frame.received)
      .toEqual([createUiBlockDocumentStart(readUiBlockTheme()), '<p>Fo', 'od', '</p>', 'close']))
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.textContent).toContain('Live view')
  })

  it('gives a new frame load the start of the document, then all of the block so far', async () => {
    await handshake(await renderCard(open('<p>Fo')))
    await act(async () => buttonNamed('Stop')!.click())
    expect(container.querySelector('iframe')).toBeNull()
    await act(async () => root.render(card(open('<p>Food'))))
    await act(async () => buttonNamed('Run')!.click())
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    const frame = new FakeFrame()
    await handshake(container.querySelector('iframe')!, frame)
    await vi.waitFor(() => expect(frame.received).toEqual([createUiBlockDocumentStart(readUiBlockTheme()), '<p>Food']))
  })

  it('stops an open block that closes with nothing but a title', async () => {
    await handshake(await renderCard(open('<title>Plan</title>')))
    await act(async () => root.render(card(
      { kind: 'block', html: '<title>Plan</title>', title: 'Plan', error: 'This view has no content.' })))
    expect(container.textContent).toContain('This view has no content.')
    expect(container.querySelector('iframe')).toBeNull()
  })

  describe('with env', () => {
    const ENV_BLOCK: InlineHtmlBlock = { ...BLOCK, env: ['TOTALS', 'EXPENSES', 'GITHUB'] }
    const START = createUiBlockDocumentStart(readUiBlockTheme(), { env: true })

    // A binding whose calls wait until the test lets them finish, and that knows when it is disposed.
    class Held extends RpcTarget {
      started = 0
      disposed = false
      readonly #waiting: (() => void)[] = []
      call() {
        this.started++
        const { promise, resolve } = Promise.withResolvers<string>()
        this.#waiting.push(() => resolve('done'))
        return promise
      }
      [Symbol.dispose]() { this.disposed = true }
    }

    let gadget: Held
    let session: Held
    let opened: string[]
    // What the next lookup of a name waits on, if the test holds it.
    let lookup: Promise<void> | undefined
    const overseer = () => ({
      connectToChatBinding: async (_chatId: number, name: string): Promise<ViewBinding> => {
        opened.push(name)
        await lookup
        if (name === 'TOTALS') return { type: 'data', json: '{"north":1200}' }
        if (name === 'EXPENSES') return { type: 'gadget', rpc: new RpcStub(gadget) }
        return { type: 'connection', session: new RpcStub(session) }
      },
    }) as unknown as RpcStub<Overseer> // A fake of the one method the card calls.
    let chatOverseer: RpcStub<Overseer>

    beforeEach(() => {
      gadget = new Held()
      session = new Held()
      opened = []
      lookup = undefined
      chatOverseer = overseer()
    })

    const envCard = (block: CardBlock = ENV_BLOCK, chat = chatOverseer) => (
      <UiBlockCard block={block} scrollRoot={scrollRoot} onHeightChange={onHeightChange}
        onSendMessage={async () => {}} chatEnv={{ overseer: chat, chatId: 1 }} />
    )
    async function renderEnvCard(block: CardBlock = ENV_BLOCK) {
      await act(async () => root.render(envCard(block)))
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      return container.querySelector('iframe')!
    }

    it('writes the block only once the frame enforces Trusted Types', async () => {
      const frame = new FakeFrame()
      await handshake(await renderEnvCard(), frame)
      await vi.waitFor(() => expect(frame.received).toEqual([START, BLOCK.html, 'close']))
    })

    it('runs nothing, opens nothing, ends the session, and says why, where Trusted Types is not enforced', async () => {
      for (const enforced of [false, 'throws'] as const) {
        const frame = new FakeFrame(enforced)
        const host = await handshake(await renderEnvCard(), frame)
        // The reason names the browser, which is what lacks the protection.
        await vi.waitFor(() => expect(container.textContent).toMatch(/browser/))
        await vi.waitFor(() => expect(frame.disposed).toBe(true))
        await expect(host.binding('TOTALS')).rejects.toBeInstanceOf(Error)
        expect(frame.received).toEqual([])
        expect(opened).toEqual([])
        await act(async () => root.render(<></>))
      }
    })

    it('opens only the names the tag lists, each once', async () => {
      const host = await handshake(await renderEnvCard())
      await expect(host.binding('OTHER')).rejects.toThrow('env.OTHER')
      expect(await host.binding('TOTALS')).toEqual({ north: 1200 })
      expect(await host.binding('TOTALS')).toEqual({ north: 1200 })
      expect(opened).toEqual(['TOTALS'])
    })

    it("paces a connection's calls and not a gadget's, and disposes both when the view stops", async () => {
      const host = await handshake(await renderEnvCard())
      const github = await host.binding('GITHUB') as unknown as RpcStub<Held> // The frame's view of it.
      const expenses = await host.binding('EXPENSES') as unknown as { rpc: RpcStub<Held> }
      const calls = Array.from({ length: 9 }, () => github.call().catch((error: Error) => error.message))
      for (let i = 0; i < 9; i++) void expenses.rpc.call().catch(() => {})
      await vi.waitFor(() => expect([session.started, gadget.started]).toEqual([8, 9]))

      await act(async () => buttonNamed('Stop')!.click())
      await vi.waitFor(() => expect([session.disposed, gadget.disposed]).toEqual([true, true]))
      // The ninth call was still queued: the frame's session ended with it.
      expect(typeof await calls[8]).toBe('string')
      expect(session.started).toBe(8)
    })

    it('disposes a stub that arrives after the view stopped', async () => {
      const held = Promise.withResolvers<void>()
      lookup = held.promise
      const host = await handshake(await renderEnvCard())
      const binding = host.binding('EXPENSES')
      await vi.waitFor(() => expect(opened).toEqual(['EXPENSES']))
      await act(async () => buttonNamed('Stop')!.click())
      held.resolve()
      // The frame's session ended first, so its own error reaches the frame.
      await expect(binding).rejects.toBeInstanceOf(Error)
      await vi.waitFor(() => expect(gadget.disposed).toBe(true))
    })

    it('opens a name again in the new session that Run starts', async () => {
      const host = await handshake(await renderEnvCard())
      await host.binding('EXPENSES')
      await act(async () => buttonNamed('Stop')!.click())
      await act(async () => buttonNamed('Run')!.click())
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const again = await handshake(container.querySelector('iframe')!)
      await again.binding('EXPENSES')
      expect(opened).toEqual(['EXPENSES', 'EXPENSES'])
    })

    it('mounts a view with env again for a new kernel session, and leaves one without env', async () => {
      const iframe = await renderEnvCard()
      await act(async () => root.render(envCard(ENV_BLOCK, overseer())))
      expect(container.querySelector('iframe')).not.toBe(iframe)

      const plain = await renderEnvCard(BLOCK)
      await act(async () => root.render(envCard(BLOCK, overseer())))
      expect(container.querySelector('iframe')).toBe(plain)
    })
  })
})
