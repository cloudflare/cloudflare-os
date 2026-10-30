// A `<gadget-ui>` block's frame, in Chromium: the browser, not the agent's instructions, keeps a
// view's code from parsing the data it shows as HTML.

import { RpcSession } from 'capnweb'
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
    frame.write(createUiBlockDocumentStart(THEME) + body).catch(reject)
    frame.close().catch(reject)
    resolve(session)
  })
  iframe.srcdoc = createUiBlockShell(THEME)
  return promise
}

/** Runs `body` as a block in a frame and returns the first message it asks to send. */
function runBlock(body: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  openBlock(body, { onMessageRequest: resolve, onResize: () => {}, onError: message => reject(new Error(message)) })
    .catch(reject)
  return promise
}

it('lets a view clear an element, but not parse a string as HTML or as a handler', async () => {
  const message = await runBlock(`
    <p id="out">Loading</p>
    <script type="module">
      const out = document.getElementById("out");
      const attempts = {
        innerHTML: () => { out.innerHTML = "<img src=x onerror=alert(1)>"; },
        insertAdjacentHTML: () => out.insertAdjacentHTML("beforeend", "<b>x</b>"),
        onclickAttribute: () => out.setAttribute("onclick", "alert(1)"),
        ownPolicy: () => trustedTypes.createPolicy("mine", { createHTML: html => html }),
        blockPolicy: () => trustedTypes.createPolicy("gadget-ui", { createHTML: html => html }),
      };
      const refused = Object.keys(attempts).filter(name => {
        try { attempts[name](); return false; } catch { return true; }
      });
      out.innerHTML = "";
      agent.send(JSON.stringify({ refused, cleared: out.childNodes.length === 0 }));
    </script>`)

  expect(JSON.parse(message)).toEqual({
    refused: ['innerHTML', 'insertAdjacentHTML', 'onclickAttribute', 'ownPolicy', 'blockPolicy'],
    cleared: true,
  })
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
