// An `<inline-html>` block's frame, in Chromium.

import { RpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it } from 'vitest'
import {
  createUiBlockDocumentStart, createUiBlockShell, UiBlockHostImpl, type UiBlockFrame, type UiBlockHostOptions,
  type UiBlockTheme,
} from './uiBlockFrame'

const THEME: UiBlockTheme = { scheme: 'light', tokens: {} }

const resources: Disposable[] = []

afterEach(() => {
  for (const resource of resources.splice(0).toReversed()) resource[Symbol.dispose]()
})

/**
 * The host's end of a frame's port, as newMessagePortRpcSession builds it, but as a session, which
 * reports its stats.
 */
function hostSession(port: MessagePort, host: UiBlockHostImpl): RpcSession<UiBlockFrame> {
  const inbox: unknown[] = []
  let waiting: ((message: unknown) => void) | undefined
  port.addEventListener('message', event => {
    if (waiting === undefined) inbox.push(event.data)
    else { waiting(event.data); waiting = undefined }
  })
  port.start()
  return new RpcSession<UiBlockFrame>({
    encodingLevel: 'structuredClonable',
    send: message => port.postMessage(message),
    receive: () => inbox.length > 0
      ? Promise.resolve(inbox.shift())
      : new Promise(resolve => { waiting = resolve }),
  }, host)
}

/** Runs `body` as a block in a frame, as the card does, and returns the host's session. */
function openBlock(body: string, options: UiBlockHostOptions): Promise<RpcSession<UiBlockFrame>> {
  const env = options.env !== undefined
  const { promise, resolve, reject } = Promise.withResolvers<RpcSession<UiBlockFrame>>()
  const iframe = document.body.appendChild(document.createElement('iframe'))
  iframe.sandbox.add('allow-scripts')
  resources.push({ [Symbol.dispose]: () => iframe.remove() })
  window.addEventListener('message', function handshake(event) {
    const port = event.ports[0]
    if (event.source !== iframe.contentWindow || port === undefined) return
    window.removeEventListener('message', handshake)
    const session = hostSession(port, new UiBlockHostImpl(options))
    const frame = session.getRemoteMain()
    resources.push(frame)
    frame.write(createUiBlockDocumentStart(THEME, { env }) + body).catch(reject)
    frame.close().catch(reject)
    resolve(session)
  })
  iframe.srcdoc = createUiBlockShell(THEME, { env })
  return promise
}

class FakeGadget extends RpcTarget {
  total() { return 7 }
}

// A host whose view reports through agent.send, and whose env holds saved data and a gadget.
const envOptions = (sent: string[], env = true): UiBlockHostOptions => ({
  onMessageRequest: message => sent.push(message), onResize: () => {}, onError: message => sent.push(`error: ${message}`),
  ...env && { env: {
    names: ['TOTALS', 'EXPENSES'],
    onOpenBinding: async name => name === 'TOTALS'
      ? { type: 'data', json: '{"north":1200,"note":"<img src=x onerror=agent.send(\'ran\')>"}' }
      : { type: 'gadget', rpc: new RpcStub(new FakeGadget()) },
  } },
})

it("reads a view's saved data and calls its gadget through env", async () => {
  const sent: string[] = []
  await openBlock(`<script type="module">
    const { north } = await env.TOTALS;
    agent.send(north + " / " + await env.EXPENSES.rpc.total());
  </script>`, envOptions(sent))
  await expect.poll(() => sent).toEqual(['1200 / 7'])
})

it('parses no string as HTML in a view with env, so data written as HTML runs nothing', async () => {
  const sent: string[] = []
  const session = await openBlock(`<div id="out"></div><script type="module">
    const { note } = await env.TOTALS;
    const out = document.getElementById("out");
    try { out.innerHTML = note; agent.send("parsed"); } catch { agent.send("refused"); }
    out.textContent = note;
    agent.send(out.textContent === note ? "as text" : "lost");
  </script>`, envOptions(sent))
  expect(await session.getRemoteMain().trustedTypes()).toBe(true)
  await expect.poll(() => sent).toEqual(['refused', 'as text'])
  // Long enough for a blocked image's error event, had the injected handler been parsed.
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(sent).toEqual(['refused', 'as text'])
})

it('leaves a view without env free to parse strings as HTML', async () => {
  const sent: string[] = []
  const session = await openBlock(`<div id="out"></div><script type="module">
    try { document.getElementById("out").innerHTML = "<b>bold</b>"; agent.send("parsed"); } catch { agent.send("refused"); }
  </script>`, envOptions(sent, false))
  expect(await session.getRemoteMain().trustedTypes()).toBe(false)
  await expect.poll(() => sent).toEqual(['parsed'])
})

it('releases what a view asks to send, though its code ignores the result', async () => {
  const sent: string[] = []
  const session = await openBlock(`
    <script type="module">
      for (let i = 0; i < 8; i++) agent.send("Show me week " + i + ".");
    </script>`, { onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {} })

  await expect.poll(() => sent.length).toBe(8)
  // Left is the host the frame was given: the eight requests' results are all released.
  await expect.poll(() => session.getStats().exports).toBe(1)
})
