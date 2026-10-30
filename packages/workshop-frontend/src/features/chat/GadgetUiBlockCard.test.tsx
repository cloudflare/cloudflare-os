// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// The block's document as the frame gets it, in order: each write, then 'close' once it ends.
class FakeFrame extends RpcTarget implements UiBlockFrame {
  received: string[] = []
  setTheme() {}
  write(html: string) { this.received.push(html) }
  close() { this.received.push('close') }
}

type CardBlock = GadgetUiBlockCardProps['block']

const BLOCK: GadgetUiBlock = { kind: 'block', html: '<p>hi</p>', title: 'Spending' }
const open = (html: string): CardBlock => ({ kind: 'open', text: `<gadget-ui>\n${html}`, html })

describe('GadgetUiBlockCard', () => {
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
    <GadgetUiBlockCard block={block} scrollRoot={scrollRoot} sendBlockedReason={sendBlockedReason}
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

  it('stops a view whose document loaded again', async () => {
    const iframe = await renderCard()
    await handshake(iframe)
    const { port2 } = new MessageChannel()
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake', origin: 'null', source: iframe.contentWindow, ports: [port2],
      }))
    })

    await vi.waitFor(() => expect(container.textContent).toContain('reloaded itself'))
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeDefined()
  })

  it('runs nothing for a block that must not run', async () => {
    await act(async () => root.render(card({ ...BLOCK, error: 'This view has no content.' })))
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
    expect(buttonNamed('Reload')).toBeUndefined()
  })
})
